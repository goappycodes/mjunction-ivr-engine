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
second-level confirm menu on "press 1", one closing per terminal branch) and
because every word a caller hears is served by this project's own dynamic URLs.
Exotel only ever decides *which URL to call*; this project decides *what that
URL says*.

### The flow

Three Gather nodes and two Switch Cases. `1` always means "all good" and `2`
always means "something is wrong", in both scripts.

```
                        ┌───────────────────────┐
                        │  Gather  /welcome     │
                        │  press 1  |  press 2  │
                        └────┬─────────────┬────┘
                          1  │             │  2
                             ▼             │
                   ┌───────────────────┐   │
                   │  Gather  /address │   │
                   │  press 1 | press 2│   │
                   └────┬───────────┬──┘   │
                     1  │           │  2   │
                        ▼           └──────┤
              ┌──────────────────┐         ▼
              │  Gather  /done   │   ┌──────────────────┐
              │  "confirmed"     │   │  Gather  /issue  │
              └────────┬─────────┘   │  "we'll call you"│
                       │             └────────┬─────────┘
                       ▼                      ▼
                    Hangup                 Hangup
              outcome: confirmed      outcome: issue_raised
```

What each node says, per script:

| Node | `order_confirmation` | `delivery_confirmation` |
| --- | --- | --- |
| `/welcome` | confirm the order | did you receive the delivery |
| `/address` | confirm the address | confirm the item delivered |
| `/done` | address confirmed | delivery confirmed |
| `/issue` | — the same escalation message for every press-2 — | |

**Both press-2 branches converge on `/issue`.** The caller hears one message —
*"For your assistance, we're connecting you with our team now. One of our team
members will call you shortly."* — and the call ends. No transfer is placed;
the recipient moves to `issue_raised` and an agent picks them up from
mjunction's escalations queue. At that point the only thing true of all four
press-2 cases is that a person will follow up, which is why the wording is
deliberately generic.

Outcomes written: `/done` → `confirmed`, `/issue` → `issue_raised`, and a call
that never reaches a menu → `no_answer` / `not_reachable` from Exotel's
terminal status (see "Call recording & terminal status").

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
  `issue_raised`, no-answer/busy/failed → `delivery_unreachable`. The order
  script's `orderConfirmationStatusFor` is the mirror image, and both now send
  every press-2 to `issue_raised`.
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
| `record` | no | Defaults to **`true`** so `status-callback` always has a `RecordingUrl` to attach; pass `record: false` per-call to opt out. This is a plain form field on `Calls/connect`, so on an account without call recording enabled it is expected to have no effect rather than reject the request — worth confirming with one real test call before relying on it, since this hasn't been verified against a live Exotel account |

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
- `PORTAL_WEBHOOK_URL` — mjunction's `/api/telephony/webhook`, POSTed to after
  a call finalizes or gets a recording attached (see
  `notifyPortalCallRecordsRefresh` in `_shared/orders.ts`). Missing/unresolved
  here means the webhook silently never fires, even if the value is correct
  in `supabase/.env.local` — this block is what actually surfaces it into the
  edge runtime.
- `IVR_SHARED_SECRET` — sent as the `x-ivr-shared-secret` header on that
  request; must match mjunction's own `IVR_SHARED_SECRET` exactly.

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
| Address confirm | Gather | `<FUNCTIONS_URL>/dynamic-greeting/address` | 1 → done, **2 → issue** |
| Closing (confirmed) | Gather | `<FUNCTIONS_URL>/dynamic-greeting/done` | → Greeting → Hangup |
| Closing (issue raised) | Gather | `<FUNCTIONS_URL>/dynamic-greeting/issue` | → Hangup |

These same four applets serve the delivery-confirmation script too, with
different prompts — see "Two scripts, one Exotel app" above. The node names
here are the order-confirmation vocabulary because that flow was built first;
nothing in Exotel needs renaming or rewiring for the second script.

### Migrating from the old transfer flow (**one-time Exotel change**)

The Address confirm menu's "press 2" used to go to a Greeting and then a
**Connect** applet that live-transferred the caller to their assigned
telecaller. That is gone — the `connect-support` and `connect-telecaller`
functions have been deleted from this repo.

**If your Exotel flow still has those nodes, do this once:**

1. On the **Address confirm** Gather's Switch Case, repoint **Case 2** from the
   Greeting to the existing **Closing (issue raised)** Gather.
2. Delete the now-orphaned **Greeting** and **Connect** applets.

Until step 1 is done, a second-menu "press 2" still fetches the deleted
`connect-telecaller` URL, which now 404s — Exotel drops the caller. The code
change alone does not complete the migration.

If you would rather keep a *separate* closing node for the second menu (to give
it its own wording later), point that node at
`<FUNCTIONS_URL>/dynamic-greeting/escalate` instead — `escalate` and
`address-issue` are accepted aliases of `issue` and behave identically.

If the functions are still deployed from a previous release, remove them:

```bash
supabase functions delete connect-support
supabase functions delete connect-telecaller
```

Any unrecognised `step` on `dynamic-greeting` still returns a valid closing
message rather than a 404.

`status-callback` is **not** wired into the Exotel flow builder like the
applets above — it is not an applet at all. `ivr-engine` passes it as the
`StatusCallback` URL on the `Calls/connect` request itself (subscribed to the
`terminal` event), so Exotel calls it automatically once per call, with no
Exotel-side configuration needed. See "Call recording & terminal status"
below.

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
`address_confirmed` / `issue_raised` / `order_unreachable` once the outcome is
known — rather than only once at the very end.

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
