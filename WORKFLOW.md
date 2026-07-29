# Exotel IVR Engine — Implementation Workflow

Step-by-step guide for building and deploying this project: a standalone
Supabase Edge Function that triggers outbound IVR calls through Exotel's
Voice v1 API, and (optionally) wiring it into a parent application.

## 1. Architecture

```
Parent app / caller            Supabase Edge Function          Exotel
──────────────────             ───────────────────────         ──────
POST { phoneNumber,      ──▶   ivr-engine/index.ts
       orderId, language }         │ validates request
                                    ▼
                              ivr-engine/exotel.ts
                                    │ POST /Calls/connect.json ──▶  dials CallerId,
                                    │ (Basic auth: key:token)        then recipient,
                                    ▼                                plays ExoML flow
                              { providerCallRef,                     (App Bazaar App ID)
                                status, raw }         ◀────────────  Call SID + status
       ◀────────────────────
{ success, provider,
  providerCallRef, status }
```

The edge function only **initiates** the call. Exotel independently posts
call-status callbacks (answered / no-answer / DTMF input, etc.) to whatever
URL is configured on the ExoML applet / App Bazaar flow — that callback
route lives in the *parent* application, not in this repo (see [§5](#5-integrating-into-a-parent-application)).

## 2. Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli) installed (`npm i -g supabase` or via package manager)
- Docker running (required for `supabase start` locally)
- An Exotel account with Voice API enabled, providing:
  - Account SID
  - API Key + API Token (from Exotel dashboard → Settings → API Credentials)
  - A verified Caller ID (virtual number you're allowed to dial from)
  - An **App Bazaar** applet (ExoML flow) that defines the IVR menu/language logic — note its **App ID**
  - Your account's API subdomain (e.g. `api` or a region-specific one like `in.exotel`)

## 3. Step-by-step: standalone edge function

### 3.1 Initialize the Supabase project
```bash
supabase init
```
This scaffolds `supabase/config.toml` and `supabase/.gitignore`. Add a root
`.gitignore` excluding `.env`, `.env.local`, and `supabase/.env.local` — never
`.env.example` needs excluding (it should only ever hold placeholders).

### 3.2 Scaffold the edge function
```bash
supabase functions new ivr-engine
```
This creates `supabase/functions/ivr-engine/index.ts`. Register it in
`supabase/config.toml`:
```toml
[functions.ivr-engine]
enabled = true
verify_jwt = false   # set true if only your parent app (with a valid JWT) should call this
import_map = "./functions/ivr-engine/deno.json"
entrypoint = "./functions/ivr-engine/index.ts"
```
`verify_jwt = false` is used here because the function is invoked
server-to-server from the parent app rather than directly from a browser
session — if you expose this function publicly, turn JWT verification back on
or add your own shared-secret check.

### 3.3 Define environment variables / secrets
Copy [.env.example](.env.example) to `supabase/.env.local` for local testing and fill in real values:
```
EXOTEL_API_KEY=
EXOTEL_API_TOKEN=
EXOTEL_ACCOUNT_SID=
EXOTEL_SUBDOMAIN=      # e.g. api or api.exotel.com
EXOTEL_CALLER_ID=      # verified virtual number
EXOTEL_APP_ID=         # App Bazaar / ExoML applet id
```
`supabase/.env.local` is git-ignored — real credentials never enter version
control. `.env.example` in the repo root stays as placeholders only.

### 3.4 Implement the Exotel client (`exotel.ts`)
Encapsulate the Exotel Voice v1 "Connect" call in its own module
([supabase/functions/ivr-engine/exotel.ts](supabase/functions/ivr-engine/exotel.ts)):
1. Read the six env vars via `Deno.env.get(...)`, fail fast if any required one is missing.
2. Build the endpoint: `https://${subdomain}.api.exotel.com/v1/Accounts/${accountSid}/Calls/connect.json`.
3. Build the ExoML flow URL: `http://my.exotel.com/${accountSid}/exoml/start_voice/${appId}`.
4. POST form-encoded params (`From`, `CallerId`, `Url`, `CustomField`) with HTTP Basic auth (`btoa(apiKey:apiToken)`).
5. Parse the JSON response; surface `RestException.Message` on failure; return `{ providerCallRef, status, raw }` on success.

### 3.5 Implement the entry point (`index.ts`)
In [supabase/functions/ivr-engine/index.ts](supabase/functions/ivr-engine/index.ts):
1. Reject non-POST requests with `405`.
2. Parse the JSON body; require `phoneNumber` and `orderId`, defaulting `language` to `"en"`.
3. Call `startExotelCall(...)` and return `{ success: true, provider: "exotel", providerCallRef, status, response }`.
4. Catch and return errors as `{ success: false, error }` with `500`.

### 3.6 (Optional) Database schema
If call attempts, campaigns, or recordings need to be tracked, add Supabase
migrations under `supabase/migrations/` (see the existing
[0001_init.sql](supabase/migrations/0001_init.sql),
[0002_auth_rls.sql](supabase/migrations/0002_auth_rls.sql),
[0003_storage.sql](supabase/migrations/0003_storage.sql) for the shape used by
the parent Gifting Fulfilment platform: `campaigns`, `recipients`,
`call_attempts`, `voc_recordings`, RLS policies keyed off `profiles.role`, and
a private `voc` storage bucket). This edge function itself is stateless and
doesn't touch these tables directly — they're written to by the parent app
after it receives Exotel's status callback.

Apply migrations:
```bash
supabase db reset        # local: recreates DB + runs all migrations + seed
# or, against a linked remote project:
supabase db push
```

### 3.7 Local development & testing
```bash
supabase start                                  # local Postgres, Studio, Auth, etc.
supabase functions serve ivr-engine --env-file ./supabase/.env.local
```
Test with curl:
```bash
curl -X POST http://127.0.0.1:54321/functions/v1/ivr-engine \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber":"+919xxxxxxxxx","orderId":"ORD-TEST-001","language":"hi"}'
```
Confirm you get back `success: true` with a `providerCallRef` (Exotel Call
SID), and that the phone actually rings.

### 3.8 Deploy
```bash
# Push real secrets to the hosted project (never commit these)
supabase secrets set --env-file ./supabase/.env.local

# Deploy the function
supabase functions deploy ivr-engine --use-api
```
Verify deployment:
```bash
curl -X POST https://<project-ref>.supabase.co/functions/v1/ivr-engine \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <anon-or-service-key>" \
  -d '{"phoneNumber":"+919xxxxxxxxx","orderId":"ORD-PROD-001"}'
```
Cross-check the call in the Exotel dashboard's call log (Sid, status, cost).

## 4. Testing checklist

- [ ] Missing `phoneNumber` → `400` with a clear error
- [ ] Missing `orderId` → `400` with a clear error
- [ ] Non-POST method → `405`
- [ ] Missing Exotel env vars → function throws a descriptive error, not a silent 500
- [ ] Exotel API error (e.g. bad credentials) → `RestException.Message` surfaced in the response
- [ ] Successful call → real phone rings and plays the correct ExoML flow/language
- [ ] `providerCallRef` matches the Call SID visible in the Exotel dashboard

## 5. Integrating into a parent application

These steps happen in the *consuming* app's codebase, not here:

1. **Provider abstraction** — add an `ExotelProvider` implementing the app's
   telephony provider interface (parallel to a `MockTelephonyProvider`, per
   [supabase/seed/seed.ts](supabase/seed/seed.ts)), so campaigns can switch
   provider by config instead of code changes.
2. **Environment variables** — add the same six `EXOTEL_*` vars to the parent
   app's own secrets/config (it needs them only if it calls Exotel directly;
   if it only calls this edge function, it just needs the function's URL +
   an auth key).
3. **Webhook route for callbacks** — add a route (e.g.
   `/api/webhooks/exotel`) that Exotel's ExoML flow posts DTMF input and call
   status to. This route should:
   - Verify the request is genuinely from Exotel (shared secret / IP allowlist, since Exotel has no HMAC signing).
   - Look up the `call_attempts` row by the Exotel Call Sid or `CustomField` (order id).
   - Update `call_attempts.outcome`, `recipients.status`, and append a `recipient_events` row.
4. **Invoke the edge function** — from the provider layer, `fetch()` this
   function's URL with the recipient's phone number, order id, and language,
   passing the Supabase anon/service key as a bearer token if `verify_jwt` is
   enabled.

## 6. Security checklist

- [ ] `.env.example` contains placeholders only — never real keys/tokens
- [ ] Real secrets live only in `supabase/.env.local` (git-ignored) and in `supabase secrets set` on the hosted project
- [ ] Rotate the Exotel API Key/Token if they were ever committed, shared in chat, or exposed in logs
- [ ] Decide deliberately on `verify_jwt` for `ivr-engine` — `false` only if you add your own auth check or it's fully internal
- [ ] RLS is enabled on every table with sensitive data (recipients, VOC recordings, call attempts)
- [ ] The `voc` storage bucket stays private; recordings are only ever accessed via short-lived signed URLs
