# Exotel IVR Engine - Supabase Edge Functions

Supabase Edge Functions for initiating outbound IVR calls via the Exotel
Voice v1 API and for serving the dynamic call flow.

**This is no longer a standalone prototype.** The "order" the whole flow
revolves around is a row in **mjunction**'s own `recipients` table — the
same admin panel that manages the recipient lifecycle. Both projects are
linked to the same Supabase project, so this repo reads and writes
`recipients` / `call_attempts` / `recipient_events` directly; there is no
separate `orders` table anymore. A real IVR call updates the exact same
status, call history and timeline the mjunction admin panel shows for a
mock call — see "How the order id flows through the call" below.

## Project Structure

`supabase/functions/ivr-engine/` — starts outbound calls
- `index.ts` - entry point: resolves the recipient, bootstraps its status,
  opens a `call_attempts` row, then calls Exotel
- `exotel.ts` - Exotel Voice v1 `Calls/connect` logic

`supabase/functions/dynamic-greeting/` — serves the live call flow to Exotel
- `index.ts` - Passthru (call-start) + dynamic Gather endpoints

`supabase/functions/connect-support/` — transfers the caller to a live agent
- `index.ts` - Exotel Connect applet (Dynamic URL) endpoint
- `config.ts` - resolves the support number + connect settings (env now, DB later)
- `exotel.ts` - maps that config onto Exotel's Connect response schema

`supabase/functions/update-order-status/` — sole owner of the `recipients` /
`call_attempts` write
- `index.ts` - finalizes a call's outcome (from a DTMF digit or an explicit
  outcome) and applies the resulting recipient status transition

`supabase/functions/status-callback/` — Exotel `StatusCallback` receiver
- `index.ts` - captures the recording URL and finalizes calls that never
  reached a menu (no-answer/busy/failed)

`supabase/functions/_shared/`
- `orders.ts` - recipient lookups, call_attempts lifecycle, call logging,
  timeout guard (used by all)
- `status.ts` - the recipient status machine, hand-kept in sync with
  mjunction's `src/lib/domain/status.ts`
- `logging.ts` - structured per-request console logging

## How the order id flows through the call

The order id — a recipient's stable `unique_id` in mjunction's `recipients`
table — is the single input to the whole flow. It is supplied once, when the
call is placed, and Exotel carries it through every applet:

```
POST /ivr-engine  { "orderId": "<recipients.unique_id>" }
        │
        │  ivr-engine resolves the recipient, bootstraps its status to
        │  order_confirm_pending, opens a call_attempts row, then calls
        │  Exotel Calls/connect with CustomField=<unique_id>
        ▼
Exotel dials the customer and runs the flow
        │
        │  Exotel echoes CustomField on every applet request
        ▼
GET /dynamic-greeting?step=welcome&CustomField=<unique_id>&CallSid=...
        │
        ▼
prompt built from that recipient's customer_name, product_name, address
        │
        │  the terminal Gather step (or, if the call never gets that far,
        │  Exotel's StatusCallback) finalizes the call_attempts row and
        │  transitions recipients.status
        ▼
mjunction's admin panel shows the updated status, call history and timeline
— no changes needed on that side, it already reads these same tables.
```

`dynamic-greeting` resolves the recipient in three steps, most reliable first:

1. **`CustomField`** — the order id `ivr-engine` passed to `Calls/connect`.
   Exotel echoes it to every applet, so this is the normal path.
2. **`CallSid`** — `ivr-engine` also stores the CallSid to order (and
   call_attempts) mapping in `ivr_logs` when it places the call, covering any
   request that arrives without a CustomField.
3. **Caller number** — the only option for an inbound call, which never
   carries a CustomField. Matched against `recipients.contact_no_e164`; since
   the same phone number can legitimately belong to more than one recipient
   across campaigns, this path is a best-effort "most recently updated wins",
   not a guaranteed-unique match.

If none resolve, the prompts degrade to generic wording rather than failing, so
the call still completes.

## POST /ivr-engine

| Field | Required | Notes |
| --- | --- | --- |
| `orderId` | **yes** | Must be a `recipients.unique_id`; 404 otherwise |
| `phoneNumber` | no | Defaults to the recipient's `contact_no_e164` |
| `statusCallbackUrl` | no | Defaults to this project's own `status-callback` function; override only to point at a different receiver |
| `record` | no | Defaults to **`true`** so `status-callback` always has a `RecordingUrl` to attach; pass `record: false` per-call to opt out. This is a plain form field on `Calls/connect` (unlike `connect-support`'s `SUPPORT_RECORD`, which is validated against Exotel's stricter Connect-applet JSON schema and documented to drop the call if wrong), so it's expected to just have no effect on an account without call recording enabled rather than reject the request — worth confirming with one real test call before relying on it, since this hasn't been verified against a live Exotel account in this change |

```bash
curl -X POST "$FUNCTIONS_URL/ivr-engine" \
  -H 'Content-Type: application/json' \
  -d '{"orderId":"<recipients.unique_id>"}'
```

Returns `{ success, callSid, status, orderId, phoneNumber }`. A 200 means Exotel
accepted the request, not that the call connected — the outcome arrives via
the Gather flow finishing or via `status-callback`. Statuses: `queued`, `in-progress`,
`completed`, `failed`, `busy`, `no-answer`.

Errors: 400 missing `orderId`, 404 unknown `orderId`, 422 no phone number
available, 405 wrong method, 503 Exotel env vars missing, 502 Exotel rejected it.

## Database prerequisites

`dynamic-greeting` / `update-order-status` / `status-callback` read and write
`recipients`, `call_attempts` and `recipient_events` — **mjunction's** tables,
created by *that* repo's migrations (`0001_init.sql` etc.), not this one's.
This repo's own migrations only cover `ivr_logs` / `ivr_call_events`
(`0004_ivr_runtime.sql`, `0005_ivr_call_events.sql`) and the link between them
(`0006_ivr_logs_call_attempt_link.sql`, adding `ivr_logs.call_attempt_id`).

**This means `supabase db reset` from this repo alone is no longer enough for
a fresh environment.** mjunction's migrations must be applied to the same
project first (or already have been — on the shared project they already are).
`ivr_logs.call_attempt_id` is deliberately a plain `uuid` column, not a foreign
key, precisely because this repo's own reset must not hard-fail just because
`call_attempts` doesn't exist yet in a database that has never seen
mjunction's migrations.

Apply this repo's migrations before pointing Exotel at the function:

```bash
supabase db reset
```

Without them every PostgREST call to `ivr_logs`/`ivr_call_events` fails
(`PGRST205` / `42501`) and nothing gets logged — but the recipient/call_attempts
writes will *also* fail (`PGRST205`) on any database that hasn't separately had
mjunction's own migrations applied.

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

`connect-support` needs a support number. Only `SUPPORT_NUMBER` is required; the
rest are optional and fall back to the defaults in `connect-support/config.ts`:
- `SUPPORT_NUMBER` — the agent number (bare `7872944208`, country-coded, or
  `+91...`; normalised to E.164). `SUPPORT_NUMBERS` (comma-separated) overrides
  it for a hunt group.
- `SUPPORT_COUNTRY_CODE` (default `91`), `SUPPORT_OUTGOING_PHONE_NUMBER`
  (optional, **must be E.164**; omitted by default so Exotel uses the first-leg
  ExoPhone), `SUPPORT_RECORD` (default `true`),
  `SUPPORT_RECORDING_CHANNELS` (`single`|`dual`, default `dual`),
  `SUPPORT_MAX_RINGING_DURATION` (default `30`, max `60`),
  `SUPPORT_MAX_CONVERSATION_DURATION` (default `900`, max `4500`),
  `SUPPORT_MUSIC_ON_HOLD_TYPE` (default `default_tone`), `SUPPORT_WAIT_MESSAGE`,
  `SUPPORT_FETCH_AFTER_ATTEMPT` (default `false`),
  `SUPPORT_CONNECT_STATUS` (the `call_attempts.outcome` value recorded on
  transfer — a value from the `call_outcome` enum, not a recipient status;
  default `transferred_to_agent`, which is what the escalations queue's
  order-type filter looks for; set empty to disable the update).

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

`status-callback` is **not** wired into the Exotel flow builder like the
applets above — it is not an applet at all. `ivr-engine` passes it as the
`StatusCallback` URL on the `Calls/connect` request itself (subscribed to the
`terminal` event), so Exotel calls it automatically once per call, with no
Exotel-side configuration needed. See "Call recording & terminal status"
below.

### Transferring to a live agent (Connect applet)

To let a caller reach the support team, add a **Connect** applet to the Exotel
flow and point its **Dynamic URL** at `connect-support`:

| Applet | URL | Purpose |
| --- | --- | --- |
| Connect (Dynamic URL) | `<FUNCTIONS_URL>/connect-support` | Dials the support number and bridges the caller |

Exotel GETs this URL mid-call and expects an `application/json` body describing
the destination and call settings. `connect-support` builds that body from the
resolved config:

```json
{
  "destination": { "numbers": ["+917872944208"] },
  "fetch_after_attempt": false,
  "record": true,
  "recording_channels": "dual",
  "max_ringing_duration": 30,
  "max_conversation_duration": 900,
  "music_on_hold": { "type": "default_tone" }
}
```

Every value here must match Exotel's documented Connect contract exactly, or
Exotel rejects the response and **drops the call** (it does not gracefully ignore
a bad field). Two fields are therefore off by default:

- `outgoing_phone_number` is **omitted** unless `SUPPORT_OUTGOING_PHONE_NUMBER`
  is set. Exotel requires it to be a valid **E.164 ExoPhone**; when omitted it
  dials the agent from the same ExoPhone as the first leg (the desired
  behaviour). Do **not** point it at a non-E.164 number like `02249360074`.
- `start_call_playback` is **omitted** unless `SUPPORT_WAIT_MESSAGE` is set. Its
  `playback_to` only accepts documented values (`both` / `callee`), so it is a
  common way to get the whole response rejected.

The support number is read from `SUPPORT_NUMBER` today. Routing is deliberately
loosely coupled: `config.ts` resolves the whole config behind a stable
`ConnectConfig` type, so it can later be fetched per-order from the database
without touching the Exotel mapping in `exotel.ts`. Exotel echoes `CustomField`
(the order id) and `CallSid` to this URL, so a future DB resolver already has the
context it needs to route.

If no number is configured the endpoint returns HTTP 500 (not a broken 200), so
Exotel runs its configured fallback instead of bridging the caller to dead air.

When it serves a number, `connect-support` also records this call's outcome —
`transferred_to_agent` by default (`SUPPORT_CONNECT_STATUS`) — by calling
`update-order-status` fire-and-forget, the same way `dynamic-greeting` does. It
never writes to `recipients` / `call_attempts` directly; that write stays owned
by one function. The update is skipped for inbound calls that carry no order id.

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

## Call recording & terminal status

`ivr-engine` subscribes every call it places to its own `status-callback`
function (via `StatusCallback` + `StatusCallbackEvents[0]=terminal` on the
`Calls/connect` request), so Exotel POSTs there once when a call reaches a
final state. That function does two things, both safe to run more than once
for the same call:

1. **Attaches the recording URL.** If Exotel sent a `RecordingUrl` (only
   present when the call was recorded and answered — see the `record` flag
   above), it's written straight onto that call's `call_attempts.recording_url`
   as-is. This is a bare external Exotel URL, not something re-hosted into
   Supabase Storage — mjunction's recipient detail page links straight out to
   it.
2. **Finalizes calls that never reached a menu.** If the Gather flow never
   got the chance to record an outcome (`no-answer` / `busy` / `failed`), this
   is the only signal there is, so it finalizes the call_attempts row from the
   terminal status alone and transitions the recipient to `order_unreachable`.
   A call that *did* complete the Gather flow already has a real outcome by
   the time this fires, so it is never overwritten with a generic one.

## How to Deploy

```bash
# Set production secrets
supabase secrets set --env-file ./supabase/.env.local

# Push the database migrations (mjunction's own migrations must already be
# applied to this project — see "Database prerequisites" above)
supabase db push

# Deploy the functions
supabase functions deploy ivr-engine --use-api
supabase functions deploy dynamic-greeting --use-api
supabase functions deploy connect-support --use-api
supabase functions deploy update-order-status --use-api
supabase functions deploy status-callback --use-api
```

## Integration notes

**Current state:** this repo's edge functions are the only thing that
actually places and drives a real Exotel call, and they write directly to
mjunction's `recipients` / `call_attempts` / `recipient_events` tables (same
Supabase project, so no API call between the two repos is needed for that).
A recipient's status now updates progressively over the life of one call —
`imported → order_confirm_pending` the moment the call is dialed, then to
`address_confirmed` / `order_unreachable` (or left at `order_confirm_pending`
for an address correction or agent transfer, matching mjunction's own
`recordOrderConfirmationCall` mapping) once the outcome is known — rather than
only once at the very end.

**Not yet done, and out of scope for this change:** mjunction's own
`TelephonyProvider` abstraction (`src/lib/telephony/`) has no `ExotelProvider`
— `TELEPHONY_PROVIDER` is still hardcoded to `mock`, and mjunction's "Call Now"
button in the admin panel does not call this repo's `/ivr-engine` endpoint.
Wiring that up is a separate, larger piece of work: mjunction's
`PlaceCallInput`/`PlaceCallResult` contract assumes a call resolves
synchronously (fits a mock call, not a real one that plays out over many
independent Exotel requests), and `app/api/telephony/webhook/route.ts` is
still the original Phase-1 stub. Until that lands, a real call has to be
triggered directly against this repo's `/ivr-engine` endpoint (e.g. from a
script, or a temporary admin action) rather than from the mjunction UI.
