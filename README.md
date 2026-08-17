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
  VOC sealing, timeout guard (used by all)
- `status.ts` - the recipient status machine, hand-kept in sync with
  mjunction's `src/lib/domain/status.ts`
- `flow.ts` - which of the two scripts (order / delivery confirmation) a call
  is running, and how that rides along in Exotel's `CustomField`
- `logging.ts` - structured per-request console logging

## Two scripts, one Exotel app

There are two IVR scripts — **order confirmation** and **delivery
confirmation** — and they share **one Exotel app, one App ID and one flow**.
Nothing in the Exotel flow builder changes to add the second one.

That works because the two scripts have the same shape (a welcome menu, a
second-level confirm menu on "press 1", a closing message per terminal branch,
a live transfer on the second-level "press 2") and because every word a caller
hears is served by this project's own dynamic URLs. Exotel only ever decides
*which URL to call*; this project decides *what that URL says*:

| Exotel node (unchanged) | `order_confirmation` | `delivery_confirmation` |
| --- | --- | --- |
| Gather `/welcome` | confirm the order | did you receive the delivery |
| Gather `/address` (case 1) | confirm the address | confirm the item delivered |
| Gather `/done` (case 1→1) | address confirmed | delivery confirmed |
| Gather `/issue` (case 2) | order issue → agent | never received → issue raised |
| Connect (case 1→2) | → assigned telecaller | → assigned telecaller |

In both scripts `1` means "all good" and `2` means "something is wrong", so the
existing Switch Case wiring stays valid either way.

Which script to read travels with the call in `CustomField`, the one per-call
value Exotel echoes to every applet request. `ivr-engine` encodes it as
`<recipients.unique_id>|oc` or `<recipients.unique_id>|dc`; every applet
endpoint decodes it with `parseCustomField` (`_shared/flow.ts`). Encoding it
there rather than looking it up per request keeps each endpoint on its single
-DB-read budget — Exotel abandons an applet URL after 5 seconds.

**A missing suffix means order confirmation**, so calls placed before this
existed, and inbound calls (which carry no `CustomField` at all), behave
exactly as they did. When the suffix is absent but the recipient *is* resolved,
the flow is inferred from that recipient's status
(`delivery_confirm_pending`/`delivery_unreachable` → delivery) as a safety net.

### What a delivery-confirmation call writes

Same tables as an order-confirmation call, with two differences:

- **Status transitions** follow `deliveryConfirmationStatusFor`
  (`_shared/status.ts`): `confirmed` → `confirmed`, `issue_raised` →
  `issue_raised`, no-answer/busy/failed → `delivery_unreachable`. A live
  transfer (`transferred_to_agent`) deliberately leaves the recipient at
  `delivery_confirm_pending` until the telecaller resolves it — same posture
  the order side takes, and the escalations queue keys off
  `call_attempts.outcome` rather than the recipient status anyway.
- **A confirmed delivery seals a VOC** (`sealDeliveryVoc`), which is what the
  vault and the client report read. It needs both a `confirmed` outcome and a
  `recording_url`, and those arrive in an unpredictable order (the outcome from
  the Gather flow, the recording from Exotel's terminal StatusCallback), so it
  is attempted from both sides and is idempotent — whichever lands second
  actually seals. `voc_recordings.storage_path` holds Exotel's own recording
  URL rather than a Supabase Storage key for these; mjunction's
  `getSignedVocUrl` returns an absolute URL as-is instead of trying to sign it.

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
| `callType` | no | `order_confirmation` (default) or `delivery_confirmation` — which script to run over the shared Exotel flow. The recipient's status is re-validated against it here (409 if it doesn't fit), since this places a real, billed call |
| `phoneNumber` | no | Defaults to the recipient's `contact_no_e164` |
| `statusCallbackUrl` | no | Defaults to this project's own `status-callback` function; override only to point at a different receiver |
| `record` | no | Defaults to **`true`** so `status-callback` always has a `RecordingUrl` to attach; pass `record: false` per-call to opt out. This is a plain form field on `Calls/connect` (unlike `connect-support`'s `SUPPORT_RECORD`, which is validated against Exotel's stricter Connect-applet JSON schema and documented to drop the call if wrong), so it's expected to just have no effect on an account without call recording enabled rather than reject the request — worth confirming with one real test call before relying on it, since this hasn't been verified against a live Exotel account in this change |

```bash
curl -X POST "$FUNCTIONS_URL/ivr-engine" \
  -H 'Content-Type: application/json' \
  -d '{"orderId":"<recipients.unique_id>"}'
```

```bash
curl -X POST "$FUNCTIONS_URL/ivr-engine" \
  -H 'Content-Type: application/json' \
  -d '{"orderId":"<recipients.unique_id>","callType":"delivery_confirmation"}'
```

Returns `{ success, callSid, status, orderId, callType, phoneNumber }`. A 200
means Exotel accepted the request, not that the call connected — the outcome
arrives via the Gather flow finishing or via `status-callback`. Statuses:
`queued`, `in-progress`, `completed`, `failed`, `busy`, `no-answer`.

Errors: 400 missing `orderId` or unknown `callType`, 404 unknown `orderId`,
409 the recipient's status isn't eligible for that `callType`, 422 no phone
number available, 405 wrong method, 503 Exotel env vars missing, 502 Exotel
rejected it.

Eligible statuses per `callType`:

| `callType` | Eligible `recipients.status` | Bootstrapped to on dial |
| --- | --- | --- |
| `order_confirmation` | `imported`, `order_confirm_pending`, `order_unreachable` | `imported` → `order_confirm_pending` |
| `delivery_confirmation` | `delivered`, `delivery_confirm_pending`, `delivery_unreachable` | `delivered` → `delivery_confirm_pending` |

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

`connect-telecaller` needs no required secret of its own — it resolves the
destination from each order's `telecaller_phone` at call time, falling back to
`SUPPORT_NUMBER`/`SUPPORT_NUMBERS` above when a recipient has none on file.
Its own knobs (`TELECALLER_*`) are all optional; see "Transferring to the
assigned telecaller" below.

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

The flow is built with **Exotel's own Switch Case node** doing the DTMF
branching — not a digit echoed between applet requests. Each Gather node's
own dynamic URL only ever needs to serve *that* node's prompt; the fact that
Exotel called a given URL at all already tells this function which branch
the caller took, because each URL is reachable from exactly one Switch Case
outcome. (An earlier version of this doc assumed Exotel echoes the previous
menu's digit into the next request — confirmed false by inspecting the raw
payload live: no `digits`/`Digits`/`dtmf` field is present at all on the
`address`/`done` steps. `dynamic-greeting/index.ts` derives the outcome
purely from which step URL was called, per the case comments there.)

Path-based routing (`/dynamic-greeting/welcome`, not `?step=welcome`) is
preferred — it survives Exotel rewriting the query string; `?step=` still
works as a fallback.

| Applet | Type | URL | Switch Case routing |
| --- | --- | --- | --- |
| Call start | Gather | `<FUNCTIONS_URL>/dynamic-greeting/welcome` | 1 → address, 2 → issue |
| Address confirm | Gather | `<FUNCTIONS_URL>/dynamic-greeting/address` | 1 → done, 2 → **Greeting → Connect** |
| Closing (confirmed) | Gather | `<FUNCTIONS_URL>/dynamic-greeting/done` | → Greeting → Hangup |
| Closing (order issue) | Gather | `<FUNCTIONS_URL>/dynamic-greeting/issue` | → Hangup |

These same four applets serve the delivery-confirmation script too, with
different prompts — see "Two scripts, one Exotel app" above. The node names
here are the order-confirmation vocabulary because that flow was built first;
nothing in Exotel needs renaming or rewiring for the second script.

The address-confirmation menu's "incorrect" branch (Case 2) does **not** call
back into `dynamic-greeting` at all — there is no `address-issue` step. It
goes straight to a Greeting (any static/dynamic Exotel greeting — e.g. "Please
hold while we connect you to your telecaller") and then a **Connect** applet
wired to `connect-telecaller` (see below), which resolves the order's
assigned telecaller and live-transfers the call. That Connect applet's own
Dynamic URL fetch is what records the `transferred_to_agent` outcome — no
separate logging step is needed before it.

Any unrecognised `step` on `dynamic-greeting` still returns a valid closing
message rather than a 404.

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

`connect-support` is not currently wired into either Switch Case branch of the
live flow (the welcome menu's "issue" branch just Gathers and hangs up) — it's
available if a future flow wants a live transfer to a generic support line.

### Transferring to the assigned telecaller (address-issue Connect applet)

The address-confirmation menu's "incorrect" branch (Case 2) needs its own
Connect applet, added **after** its Greeting node, with its Dynamic URL
pointed at `connect-telecaller`:

| Applet | URL | Purpose |
| --- | --- | --- |
| Connect (Dynamic URL) | `<FUNCTIONS_URL>/connect-telecaller` | Dials the order's assigned telecaller and bridges the caller |

`connect-telecaller` reads the same `CustomField` (order id) Exotel already
carries, looks up that recipient's `telecaller_phone` (imported per-row in
mjunction alongside `telecaller_name` — the "Tele Caller Contact No" import
column), and returns the same Exotel Connect JSON shape as `connect-support`
(shared in `_shared/connect.ts`, so both endpoints stay wire-compatible by
construction). If the order has no `telecaller_phone` on file, it falls back
to the account-wide `SUPPORT_NUMBER`/`SUPPORT_NUMBERS` — same env vars
`connect-support` uses — so a data gap degrades to "reaches someone" instead
of dropping the call. If neither resolves, the endpoint returns HTTP 500 so
Exotel runs its configured fallback URL instead of bridging to dead air.

Optional tuning env vars (all fall back to sane defaults in
`connect-telecaller/config.ts` — only set what you need to change):
`TELECALLER_COUNTRY_CODE` (default `91`), `TELECALLER_OUTGOING_PHONE_NUMBER`
(must be E.164), `TELECALLER_RECORD` (default `false`),
`TELECALLER_RECORDING_CHANNELS` (`single`|`dual`, default `single`),
`TELECALLER_MAX_RINGING_DURATION` (default `30`, max `60`),
`TELECALLER_MAX_CONVERSATION_DURATION` (default `900`, max `4500`),
`TELECALLER_MUSIC_ON_HOLD_TYPE` (default `default_tone`),
`TELECALLER_WAIT_MESSAGE`, `TELECALLER_FETCH_AFTER_ATTEMPT` (default `false`).

On success it records the call's outcome as `transferred_to_agent` (the same
outcome the escalations queue's order-type filter already looks for), via
`update-order-status`, fire-and-forget. Once the telecaller has spoken to the
caller and knows the correct address, they resolve it from the recipient's
page in mjunction (the existing "Resolve escalation" action — enter the
corrected address, or confirm it was unchanged), the same way a `SUPPORT_NUMBER`
transfer would be resolved today.

All Gather applets above conform to the same response contract; the closing
messages are Gather applets too,
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

mjunction triggers both call types from its own UI when
`TELEPHONY_PROVIDER=exotel`: "Call Now" on a recipient row calls
`triggerOrderConfirmationCall`, "Run confirmation call" calls
`triggerDeliveryConfirmationCall`, and both land on this repo's
`/ivr-engine` endpoint (`src/lib/telephony/ivr-engine-client.ts`). Neither
goes through mjunction's `TelephonyProvider.placeCall` contract — that assumes
a call resolves synchronously, which fits a mock call but not a real one that
plays out over many independent Exotel requests. `ExotelProvider.placeCall`
therefore exists only to throw, so a real deployment can never silently fall
back to mock outcomes.

With `TELEPHONY_PROVIDER=mock` (the default) both buttons keep running
mjunction's own simulated call instead, writing the same tables.
