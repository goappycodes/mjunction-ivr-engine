# Exotel IVR Engine - Supabase Edge Function

Independent Supabase Edge Function for initiating outbound IVR calls via Exotel Voice v1 API.

## Project Structure
`supabase/functions/ivr-engine/`
- `index.ts` - Edge function entry point & request validation
- `exotel.ts` - Exotel Voice v1 API connect logic

`supabase/functions/exotel-webhook/`
- `index.ts` - Receives Exotel's call-status/DTMF callbacks. Currently logs the payload and returns `200`; extend this to persist call outcomes.

## Environment Variables / Secrets
Configure the following secrets in your Supabase project (or local `supabase/.env.local` for testing):
- `EXOTEL_API_KEY`
- `EXOTEL_API_TOKEN`
- `EXOTEL_ACCOUNT_SID`
- `EXOTEL_SUBDOMAIN` (e.g., `api` or `in.exotel`)
- `EXOTEL_CALLER_ID`
- `EXOTEL_APP_ID`

## How to Deploy
Using the Supabase CLI:
```bash
# Set production secrets
supabase secrets set --env-file ./supabase/.env.local

# Deploy the function
supabase functions deploy ivr-engine --use-api

To integrate this IVR Engine into the existing application, the following changes were made:

Registered ExotelProvider in the Telephony Provider abstraction.
Added Exotel environment variables.
Updated the webhook route to process Exotel callbacks.
Invoked the Supabase Edge Function from the provider layer.