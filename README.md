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
- `index.ts` - the Greeting, Gather and Passthru endpoints the flow calls

`supabase/functions/update-order-status/` — sole owner of the `recipients` /
`call_attempts` write
- `index.ts` - finalizes a call's outcome (from a DTMF digit or an explicit
  outcome) and applies the resulting recipient status transition

`supabase/functions/status-callback/` — Exotel `StatusCallback` receiver
- `index.ts` - captures the recording URL and finalizes calls that never
  reached a menu (no-answer/busy/failed)

`supabase/functions/reconcile-calls/` — fallback for a missed/delayed
`StatusCallback`, per Exotel's own webhook guidance
- `index.ts` - every 5 minutes (self-scheduled via `Deno.cron`, plus an
  HTTP entrypoint for manual/test triggering), polls Exotel's Call Details
  API for any `call_attempts` row that looks stuck and finalizes it the same
  way `status-callback` would have

`supabase/functions/_shared/`
- `orders.ts` - recipient lookups, call_attempts lifecycle, call logging,
  VOC sealing, timeout guard (used by all)
- `status.ts` - the recipient status machine, hand-kept in sync with
  mjunction's `src/lib/domain/status.ts`
- `flow.ts` - which of the two scripts (order / delivery confirmation) a call
  is running, and how that rides along in Exotel's `CustomField`
- `exotel.ts` - Exotel Call Details API (`GET Calls/{Sid}.json`), used by
  `reconcile-calls`
- `logging.ts` - structured per-request logging: one line to the console
  (Supabase's log viewer) and one row into `ivr_request_log`, for every
  inbound request every function receives and every outbound request this
  project sends to Exotel (`Calls/connect`, Call Details)
- `db.ts` - the shared Supabase client + `waitUntil`/`functionsUrl` helpers,
  factored out of `orders.ts` so `logging.ts` doesn't have to depend on the
  whole recipient/call_attempts module just for a DB handle

## Two scripts, one Exotel app
There are two IVR scripts — **order confirmation** and **delivery
confirmation** — and they share **one Exotel app, one App ID and one flow**.
Nothing in the Exotel flow builder changes to switch between them.

That works because the two scripts have the same shape (a greeting, one menu,
one closing per terminal branch) and because every word a caller hears is
served by this project's own dynamic URLs. Exotel only ever decides *which URL
to call*; this project decides *what that URL says*.

### The flow

One Greeting, one Gather, one Switch Case, two closings. `1` always means
"all good" and `2` always means "something is wrong", in both scripts.

```
                     ┌──────────────────────────┐
                     │  Greeting  /greeting     │
                     │  who is calling, and why │
                     └────────────┬─────────────┘
                                  ▼
                     ┌──────────────────────────┐
                     │  Gather    /welcome      │
                     │  press 1   |   press 2   │
                     └────┬────────────────┬────┘
                       1  │                │  2
                          ▼                ▼
             ┌──────────────────┐   ┌──────────────────┐
             │  Gather  /done   │   │  Gather  /issue  │
             │  "confirmed"     │   │  "we've logged   │
             │                  │   │   your request"  │
             └────────┬─────────┘   └────────┬─────────┘
                      │                      │
                      ▼                      ▼
                   Hangup                 Hangup
             outcome: confirmed      outcome: issue_raised
```

What each node says, per script:

| Node | `order_confirmation` | `delivery_confirmation` |
| --- | --- | --- |
| `/greeting` | hello <name>, automated call from mjunction about order <id> | …about the delivery of order <id> |
| `/welcome` | we have your address as <address> — 1 correct, 2 change it | did it arrive and is it intact — 1 yes, 2 no |
| `/done` | address confirmed | delivery confirmed |
| `/issue` | WhatsApp link to change the address, support call if not | support will call you |

**The second menu is gone.** The old flow asked the caller to confirm the
order, *then* confirm the address — two menus that between them collected one
usable fact, because a press-2 on either produced the identical `issue_raised`
outcome. One menu asks the one question the call exists to settle, and takes
roughly 20 seconds off every call.

**The two closings now say different things.** They used to share one
deliberately vague escalation message, because a press-2 could have meant four
different things and none of them could be named. With a single menu, a
press-2 means exactly one thing per script, so each closing states what
happens next: the order script promises a WhatsApp link to change the address
with a support callback as the fallback, the delivery script promises the
callback outright.

Outcomes written: `/done` → `confirmed`, `/issue` → `issue_raised`, and a call
that never reaches the menu → `no_answer` / `not_reachable` from Exotel's
terminal status (see "Call recording & terminal status").

### The DTMF digit

`call_attempts.dtmf_response` records the key the caller pressed — `1` on
`/done`, `2` on `/issue`. It is **derived from which URL Exotel called**, not
read off the request: Exotel routes the collected digit through its own Switch
Case and does not echo it into the branch it picks (confirmed by inspecting a
live payload — no `digits` / `Digits` / `dtmf` field is present at all on the
closing steps). Each closing is reachable from exactly one branch, so the
branch *is* the digit. Anything Exotel does send still wins, as an override.

Before this, every real IVR call finalized with `dtmf_response = null` and
mjunction's DTMF column was blank for anything but a mock call.

### Outstanding: the WhatsApp hand-off

The order script's press-2 closing tells the caller they will get a WhatsApp
message with a link to update their address. **Nothing in either repo sends
that message yet.** What actually happens today is what happened before: the
recipient moves to `issue_raised` and an agent picks them up from mjunction's
escalations queue — the support-callback half of what the caller was just
promised, not the self-service half.

mjunction already has the page the link would point at
(`/order/change-address/[recipientId]`). What is missing is the send: a
WhatsApp Business API provider, a template, and a trigger off the
`issue_raised` transition. Until that exists, either land it or soften
`orderIssuePrompt` in `dynamic-greeting/index.ts` — an IVR that promises a
message no one sends is worse than one that promises only the callback.

### What a delivery-confirmation call writes

Same tables as an order-confirmation call, with two differences:

- **Status transitions** follow `deliveryConfirmationStatusFor`
  (`_shared/status.ts`): `confirmed` → `confirmed`, `issue_raised` →
  `issue_raised`, no-answer/busy/failed → `delivery_unreachable`. The order
  script's `orderConfirmationStatusFor` is the mirror image, and both send a
  press-2 to `issue_raised`.
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
GET /dynamic-greeting/greeting?CustomField=<unique_id>&CallSid=...
   then /dynamic-greeting/welcome?CustomField=<unique_id>&CallSid=...
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
(`0004_ivr_runtime.sql`, `0005_ivr_call_events.sql`), the link between them
(`0006_ivr_logs_call_attempt_link.sql`, adding `ivr_logs.call_attempt_id`), and
`ivr_request_log` (`0008_ivr_request_log.sql`) — the full request/response
payload log every `logEvent()` call writes to, in addition to the console.

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

| Applet | Type | URL | Routes to |
| --- | --- | --- | --- |
| Call start | **Greeting** | `<FUNCTIONS_URL>/dynamic-greeting/greeting` | → Menu |
| Menu | **Gather** | `<FUNCTIONS_URL>/dynamic-greeting/welcome` | Switch Case: 1 → Closing (confirmed), 2 → Closing (issue) |
| Closing (confirmed) | **Greeting** | `<FUNCTIONS_URL>/dynamic-greeting/done` | → Hangup |
| Closing (issue raised) | **Greeting** | `<FUNCTIONS_URL>/dynamic-greeting/issue` | → Hangup |

Plus one **Switch Case** node between the menu and the two closings, and a
**Hangup** after each closing. Those three have no dynamic URL — they are pure
Exotel-side nodes — which is why they are absent from a table about what to
paste where. The Switch Case is not optional: a Gather applet has a single
exit, so the digit it collects is inert until something branches on it, and
that branch is the only thing that tells this function which key was pressed.

**Only the menu is a Gather applet.** Three of the four nodes are Greeting
applets, because the caller only listens to them — the Switch Case has already
routed on the keypress by the time a closing is reached, so there is nothing
left to collect. A Greeting applet's dynamic URL expects `text/plain` (or
`{"greeting_url": "<audio url>"}`), which is what `greet()` in
`dynamic-greeting/index.ts` returns; a Gather applet expects the JSON contract
below and rejects plain text just as flatly as a Greeting applet rejects the
JSON. Crossing the two is the single most likely way to break this flow.

The closings were Gather applets until recently. Nothing about the status
write depended on that — a Greeting applet still fetches the URL, so the
outcome write, the DTMF digit and the step log all fire exactly as before —
and moving them off Gather drops the ~2 seconds of dead air that
`speak()`'s nominal digit collection left at the end of every call.

These same four applets serve the delivery-confirmation script too, with
different prompts — see "Two scripts, one Exotel app" above. The node names
here are the order-confirmation vocabulary because that flow was built first;
nothing in Exotel needs renaming or rewiring for the second script.

### Migrating to the single-menu flow (**one-time Exotel change**)

The flow used to be: Gather (confirm the order) → Gather (confirm the address)
→ two closings. It is now: **Greeting → Gather → two closings.** The second
menu is gone and the entry node is a Greeting applet rather than a Gather.

**Do this once, in the Exotel flow builder:**

1. **Add a Greeting applet as the new call-start node**, pointed at
   `<FUNCTIONS_URL>/dynamic-greeting/greeting`. It must be a **Greeting**
   applet, not a Gather — the endpoint answers `text/plain`, which is what a
   Greeting applet's dynamic URL expects and what a Gather applet rejects.
   Route it straight to the menu Gather below.
2. **Repoint the App's entry point** from the old welcome Gather to that new
   Greeting applet.
3. **Keep the old welcome Gather as the one menu**, still pointed at
   `<FUNCTIONS_URL>/dynamic-greeting/welcome`. Its Switch Case changes:
   **Case 1 → Closing (confirmed)** (it used to go to the Address confirm
   Gather), Case 2 → Closing (issue raised), unchanged.
4. **Delete the Address confirm Gather** (`/dynamic-greeting/address`). Nothing
   routes to it any more.
5. **Convert both closings from Gather applets to Greeting applets**, keeping
   their URLs (`/dynamic-greeting/done` and `/dynamic-greeting/issue`)
   unchanged. Do this *after* step 3, so the Switch Case is already pointing at
   them. Leaving them as Gather applets does not break the call — the code
   still answers, and the fallback paths still pick the right shape — but the
   caller hears the trailing dead air the Gather timeout produces.
6. **Check both closings end in Hangup.** Unchanged, but an earlier migration
   left a Greeting between `/done` and Hangup in some flows — if yours has one,
   delete it.

Order matters: do step 3 before step 4, or a "press 1" routes to a node that no
longer exists and Exotel drops the caller.

**Until step 3 is done, calls still work.** `/dynamic-greeting/address` is
accepted as an alias of the menu, so a flow still wired the old way asks the
same question twice and the caller presses 1 again to reach the same closing —
degraded, not broken. Remove the alias from `dynamic-greeting/index.ts` once
every environment is migrated.

If you would rather keep a *separately named* closing node for the press-2
branch, point it at `<FUNCTIONS_URL>/dynamic-greeting/escalate` — `escalate`
and `address-issue` are accepted aliases of `issue` and behave identically.

Any unrecognised `step` on `dynamic-greeting` still returns a valid closing
message rather than a 404, so a half-migrated flow ends calls cleanly instead
of cutting them off.

If the retired transfer functions are still deployed from an older release,
remove them:

```bash
supabase functions delete connect-support
supabase functions delete connect-telecaller
```

`status-callback` is **not** wired into the Exotel flow builder like the
applets above — it is not an applet at all. `ivr-engine` passes it as the
`StatusCallback` URL on the `Calls/connect` request itself (subscribed to the
`terminal` event), so Exotel calls it automatically once per call, with no
Exotel-side configuration needed. See "Call recording & terminal status"
below.

### Response contract

There are **two** contracts, one per applet type, and they are not
interchangeable — see the applet table above for which node gets which.

A **Greeting** applet (the opening and both closings) gets `text/plain`: the
body is simply the text to speak. `greet()` serves these.

A **Gather** applet (the menu) gets Exotel's documented Gather schema:
`gather_prompt` (mandatory, `text` or `audio_url`), `max_input_digits`,
`finish_on_key`, `input_timeout`, `repeat_menu`, `repeat_gather_prompt` —
HTTP 200 with
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

### Fallback: `reconcile-calls`

`status-callback` is push-based — it only runs if Exotel's webhook actually
reaches it. Exotel's own documentation is explicit that this isn't
guaranteed:

> StatusCallback delivery may be delayed or fail due to network issues,
> server problems, or webhook downtime. Implement fallback logic using the
> Call Details API to ensure you capture all call data.

`reconcile-calls` is that fallback. Every 5 minutes (self-scheduled via
`Deno.cron`, so no external cron needs to be wired up once this is deployed)
it:

1. Finds `call_attempts` rows that look stuck — no `outcome`, and
   `provider_status` still `queued` / `ringing` / `in-progress` / unset,
   started more than 10 minutes ago but less than 24 hours ago (see
   `getStaleOpenCallAttempts` in `_shared/orders.ts` for the exact
   definition — a call that legitimately has no outcome forever, e.g. the
   caller hung up mid-menu, already has a real terminal `provider_status`
   from `status-callback` and is correctly excluded).
2. Calls Exotel's Call Details API (`GET Calls/{Sid}.json`) directly for
   each one — `_shared/exotel.ts`.
3. Runs the exact same attach-recording / finalize-outcome / seal-VOC logic
   `status-callback` runs, so a call is finalized identically whether the
   webhook arrived or this fallback caught it. Safe to run concurrently with
   `status-callback` — every write here is the same idempotent operation
   that function already relies on.

The HTTP entrypoint (`POST`, `x-ivr-shared-secret` header, same as
`ivr-engine`) exists for manual testing and as an escape hatch if you'd
rather trigger this from an external scheduler (e.g. `pg_cron` + `pg_net`,
or a scheduler outside Supabase) instead of relying on `Deno.cron`.

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
supabase functions deploy reconcile-calls --use-api
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
