# Exotel IVR Engine - Supabase Edge Functions

Standalone Supabase Edge Functions for initiating outbound IVR calls via the
Exotel Voice v1 API and for serving the dynamic call flow.

## Project Structure

`supabase/functions/ivr-engine/` — starts outbound calls
- `index.ts` - Edge function entry point & request validation
- `exotel.ts` - Exotel Voice v1 API connect logic

`supabase/functions/dynamic-greeting/` — serves the live call flow to Exotel
- `index.ts` - Passthru (call-start) + dynamic Gather endpoints

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

Changes to `config.toml` or `supabase/.env.local` require a restart to take
effect locally:

```bash
supabase stop && supabase start
```

## Exotel applet configuration

Point the Exotel flow at these URLs (both must return HTTP 200; the Gather URLs
must return `application/json` or Exotel drops the call):

| Applet | URL |
| --- | --- |
| Passthru (call start) | `<FUNCTIONS_URL>/dynamic-greeting` |
| Gather — order confirm | `<FUNCTIONS_URL>/dynamic-greeting?step=welcome` |
| Gather — address confirm | `<FUNCTIONS_URL>/dynamic-greeting?step=address` |
| Play — closing message | `<FUNCTIONS_URL>/dynamic-greeting?step=done` |

Any unrecognised `step` now returns a valid closing message rather than a 404.

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
