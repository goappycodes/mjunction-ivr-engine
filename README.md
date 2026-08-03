# Exotel IVR Engine - Supabase Edge Functions

Standalone Supabase Edge Functions for initiating outbound IVR calls via the
Exotel Voice v1 API and for serving the dynamic call flow.

## Project Structure

`supabase/functions/ivr-engine/` — starts outbound calls
- `index.ts` - entry point, validates the order, records the CallSid mapping
- `exotel.ts` - Exotel Voice v1 `Calls/connect` logic

`supabase/functions/dynamic-greeting/` — serves the live call flow to Exotel
- `index.ts` - Passthru (call-start) + dynamic Gather endpoints

`supabase/functions/ivr-status-callback/` — receives Exotel's call-status webhook
- `index.ts` - records every telephony status event Exotel sends for a call

`supabase/functions/_shared/`
- `orders.ts` - order lookups, call logging, status-callback recording, timeout guard
- `params.ts` - Exotel request-parameter parsing, shared by `dynamic-greeting` and `ivr-status-callback`
- `callState.ts` - the two call-state enums (see "Call state flow" below)

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

`statusCallbackUrl` defaults to `IVR_STATUS_CALLBACK_URL` (see below) when the
caller does not pass one, so every call gets its telephony outcome recorded
without remembering to wire it manually each time.

## POST/GET /ivr-status-callback (Exotel StatusCallback receiver)

Not called by your application — Exotel calls this. `ivr-engine` passes its URL
as the `StatusCallback` parameter on `Calls/connect`, subscribed to the
`terminal` event, so Exotel POSTs here once a call ends: `completed`, `failed`,
`busy`, or `no-answer`.

This endpoint has one job: capture every param Exotel sends and update the
call's telephony status. It plays no audio and is unrelated to the Gather flow
in `dynamic-greeting` — that flow tracks how far the *caller* got in the
conversation; this tracks what the *call itself* ended up doing.

Every request is recorded twice:
- `ivr_logs.call_status` / `ivr_logs.ended_at` — the latest known outcome for
  that `CallSid`, alongside the existing conversational `status`/`step` columns.
- `ivr_status_events` — an append-only row per callback, with the entire raw
  payload in `raw` (jsonb), so a status Exotel sends that isn't recognised yet
  is still captured instead of silently dropped.

Always responds `200` with an empty body — Exotel only checks the status code
here, and a DB fault must not make Exotel retry a call that has already ended.

## Call state flow

Two independent states are tracked per call (`supabase/functions/_shared/callState.ts`):

**`ivr_logs.status`** — the conversational state, i.e. how far the caller got
in the menu. Set by `dynamic-greeting` on every applet request:

```
CALL_STARTED
  -> WELCOME_SERVED (or _NO_ORDER / _NO_STEP)
       -> ORDER_CONFIRMED  (digit 1 on the welcome menu)
       -> ORDER_ISSUE_RAISED (digit 2 on the welcome menu)
            -> ADDRESS_PROMPT_SERVED
                 -> ADDRESS_CONFIRMED (digit 1 on the address menu)
                 -> ADDRESS_ISSUE_RAISED (digit 2 on the address menu)
UNKNOWN_STEP  (any unrecognised `step` param, at any point)
```

**`ivr_logs.call_status`** — Exotel's telephony outcome for the call itself.
Set to `queued` by `ivr-engine` when the call is placed, and finalized by
`ivr-status-callback` to one of: `ringing`, `in-progress`, `completed`,
`failed`, `busy`, `no-answer`.

They are kept separate rather than merged into one flow because they can
diverge — a call can reach `ADDRESS_CONFIRMED` and still end up `failed` if the
line drops before the closing message, or Exotel can report `completed` for a
call that never answered a single Gather prompt. Query both columns together
(`select status, call_status from ivr_logs where call_sid = ...`) to get the
full picture of where a given call actually ended up.

To add a new conversational state: extend `IVR_STATES` in `callState.ts` and
the corresponding `case` in `dynamic-greeting/index.ts`'s switch. Nothing else
needs to change — `ivr-status-callback` and the telephony `call_status` track
are independent of it.

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

`dynamic-greeting` and `ivr-status-callback` need only the auto-injected
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` — do not declare these yourself.

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
- `IVR_STATUS_CALLBACK_URL` — deployed URL of `ivr-status-callback`
  (`<FUNCTIONS_URL>/ivr-status-callback`), used as the default `StatusCallback`
  for every call. Optional locally (Exotel cannot reach a `127.0.0.1` URL
  anyway); required once deployed if you want call outcomes recorded.

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

`ivr-status-callback` is **not** one of these applet nodes — Exotel calls it
directly as the `StatusCallback` URL passed on `Calls/connect` (set via
`IVR_STATUS_CALLBACK_URL`, above), not through the App Bazaar flow. Nothing to
configure in the Exotel dashboard for it beyond that env var.

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
supabase functions deploy ivr-status-callback --use-api
```

After the first deploy of `ivr-status-callback`, set `IVR_STATUS_CALLBACK_URL`
to its URL and re-set secrets so `ivr-engine` picks it up:

```bash
supabase secrets set IVR_STATUS_CALLBACK_URL="$FUNCTIONS_URL/ivr-status-callback"
```

## Integration notes

To integrate this IVR Engine into the existing application, the following
changes were made:

- Registered `ExotelProvider` in the Telephony Provider abstraction.
- Added Exotel environment variables.
- Updated the webhook route to process Exotel callbacks.
- Invoked the Supabase Edge Function from the provider layer.
