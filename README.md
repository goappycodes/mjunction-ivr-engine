# Exotel IVR Engine - Supabase Edge Functions

Standalone Supabase Edge Functions for initiating outbound IVR calls via the
Exotel Voice v1 API and for serving the dynamic call flow.

## Project Structure

`supabase/functions/ivr-engine/` — starts outbound calls
- `index.ts` - entry point, validates the order, records the CallSid mapping
- `exotel.ts` - Exotel Voice v1 `Calls/connect` logic

`supabase/functions/dynamic-greeting/` — serves the live call flow to Exotel
- `index.ts` - Passthru (call-start) + dynamic Gather endpoints

`supabase/functions/_shared/`
- `orders.ts` - order lookups, call logging, timeout guard (used by both)

## How the order id flows through the call

The order id is the single input to the whole flow. It is supplied once, when the
call is placed, and Exotel carries it through every applet:

```
POST /ivr-engine  { "orderId": "ORD12345" }
        │
        │  ivr-engine loads the order, then calls Exotel Calls/connect
        │  with CustomField=ORD12345
        ▼
Exotel dials the customer and runs the flow
        │
        │  Exotel echoes CustomField on every applet request
        ▼
GET /dynamic-greeting?step=welcome&CustomField=ORD12345&CallSid=...
        │
        ▼
prompt built from that order's customer_name, product_name, delivery_address
```

`dynamic-greeting` resolves the order in three steps, most reliable first:

1. **`CustomField`** — the order id `ivr-engine` passed to `Calls/connect`.
   Exotel echoes it to every applet, so this is the normal path.
2. **`CallSid`** — `ivr-engine` also stores the CallSid to order mapping in
   `ivr_logs` when it places the call, covering any request that arrives without
   a CustomField.
3. **Caller number** — the only option for an inbound call, which never carries a
   CustomField.

If none resolve, the prompts degrade to generic wording rather than failing, so
the call still completes.

## POST /ivr-engine

| Field | Required | Notes |
| --- | --- | --- |
| `orderId` | **yes** | Must exist in `orders`; 404 otherwise |
| `phoneNumber` | no | Defaults to the order's `phone_number` |
| `statusCallbackUrl` | no | Subscribes to Exotel's `terminal` event |
| `record` | no | Defaults to `false` |

```bash
curl -X POST "$FUNCTIONS_URL/ivr-engine" \
  -H 'Content-Type: application/json' \
  -d '{"orderId":"ORD12345"}'
```

Returns `{ success, callSid, status, orderId, phoneNumber }`. A 200 means Exotel
accepted the request, not that the call connected — the outcome arrives via
`StatusCallback` or the Call Details API. Statuses: `queued`, `in-progress`,
`completed`, `failed`, `busy`, `no-answer`.

Errors: 400 missing `orderId`, 404 unknown `orderId`, 422 no phone number
available, 405 wrong method, 503 Exotel env vars missing, 502 Exotel rejected it.

## Database prerequisites

`dynamic-greeting` reads `orders` and writes `ivr_logs`. Both are created by
`supabase/migrations/0004_ivr_runtime.sql`, which also adds the unique indexes
the function's `.maybeSingle()` lookup and `.upsert({ onConflict: "call_sid" })`
depend on, plus the `service_role` GRANTs the Data API needs.

Apply migrations before pointing Exotel at the function:

```bash
supabase db reset
```

Without this migration every PostgREST call fails (`PGRST205` / `42501`), the
greeting announces the hardcoded fallback order id, and nothing is logged.

## Environment Variables / Secrets

`dynamic-greeting` needs only the auto-injected `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` — do not declare these yourself.

`ivr-engine` needs the following, kept in `supabase/.env.local` (gitignored)
and surfaced to the local edge runtime by the `[edge_runtime.secrets]` block in
`supabase/config.toml`:
- `EXOTEL_API_KEY`
- `EXOTEL_API_TOKEN`
- `EXOTEL_ACCOUNT_SID`
- `EXOTEL_SUBDOMAIN` — full host (`api.in.exotel.com` for India,
  `api.exotel.com` for Singapore) or a bare subdomain
- `EXOTEL_CALLER_ID`
- `EXOTEL_APP_ID`

`supabase start` has no `--env-file` flag — `env(...)` in `config.toml` is
resolved from the **process environment**, so the file must be exported into the
shell first. Verified procedure:

```bash
set -a && . ./supabase/.env.local && set +a && supabase stop && supabase start
```

Confirm they landed:

```bash
docker exec supabase_edge_runtime_mjunction-portal env | grep EXOTEL
```

Note: `docker restart` on the edge-runtime container will **delete** it (the CLI
runs it with `--rm`). Use `supabase stop && supabase start` instead.

## Exotel applet configuration

Point the Exotel flow at these URLs (both must return HTTP 200; the Gather URLs
must return `application/json` or Exotel drops the call):

| Applet | URL | Routing |
| --- | --- | --- |
| Passthru (call start) | `<FUNCTIONS_URL>/dynamic-greeting` | → welcome |
| Gather — order confirm | `<FUNCTIONS_URL>/dynamic-greeting?step=welcome` | 1 → address, 2 → issue |
| Gather — address confirm | `<FUNCTIONS_URL>/dynamic-greeting?step=address` | 1 → done, 2 → issue |
| Gather — closing | `<FUNCTIONS_URL>/dynamic-greeting?step=done` | → hangup |
| Gather — issue closing | `<FUNCTIONS_URL>/dynamic-greeting?step=issue` | → hangup |

Exotel appends its own parameters to whatever URL you configure, so
`?step=welcome` arrives as
`?step=welcome&CallSid=...&CallFrom=...&CustomField=...&digits="1"`.
The digit pressed on one menu arrives with the request for the *next* applet —
which is why `step=address` records the answer to the order question, and
`step=done` records the answer to the address question.

Any unrecognised `step` now returns a valid closing message rather than a 404.

All four are **Gather** applets. The closing messages are Gather applets too,
not Greeting applets — a Greeting applet's dynamic URL expects a different body
(`{"greeting_url": "..."}` or `text/plain`) and would reject the Gather payload
this function returns.

### Response contract

Every response conforms to Exotel's documented Gather schema: `gather_prompt`
(mandatory, `text` or `audio_url`), `max_input_digits`, `finish_on_key`,
`input_timeout`, `repeat_menu`, `repeat_gather_prompt` — HTTP 200 with
`Content-Type: application/json`.

`max_input_digits` and `finish_on_key` are always sent explicitly, because
Exotel's defaults (255 digits and `#`) are both wrong for a single-digit menu.
An empty `finish_on_key` is valid and documented as "no finish key".

**Exotel gives an application URL 5 seconds before it abandons the call.** Two
things protect that budget: dependencies resolve through the import map instead
of a runtime `https://esm.sh/...` fetch (which pushed cold starts to 7.3s), and
the one blocking query is capped at 1.5s via `DB_TIMEOUT_MS`, falling back to the
default order id. Audit writes go to `EdgeRuntime.waitUntil` so they never block
the reply. Measured: ~15-25ms warm, under 0.2s cold, 1.5s worst case with the
database completely unreachable.

## How to Deploy

```bash
# Set production secrets
supabase secrets set --env-file ./supabase/.env.local

# Push the database migrations
supabase db push

# Deploy the functions
supabase functions deploy ivr-engine --use-api
supabase functions deploy dynamic-greeting --use-api
```

## Integration notes

To integrate this IVR Engine into the existing application, the following
changes were made:

- Registered `ExotelProvider` in the Telephony Provider abstraction.
- Added Exotel environment variables.
- Updated the webhook route to process Exotel callbacks.
- Invoked the Supabase Edge Function from the provider layer.
