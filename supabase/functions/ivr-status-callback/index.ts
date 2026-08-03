import "@supabase/functions-js/edge-runtime.d.ts";
import { firstOf, paramsToObject, readParams } from "../_shared/params.ts";
import { recordStatusCallback, withTimeout } from "../_shared/orders.ts";

// ---------------------------------------------------------------------------
// Exotel StatusCallback receiver.
//
// `ivr-engine` passes this function's URL as `StatusCallback` when it places
// a call (see ivr-engine/exotel.ts), subscribed to the `terminal` event.
// Exotel POSTs here once the call ends — completed, failed, busy, or
// no-answer — with `CallSid`, `Status`, `EventType`, and other call metadata
// as form/query params. This endpoint's only job is to capture every one of
// those params and update the call's telephony status; it plays no audio and
// is unrelated to the Gather flow in `dynamic-greeting`.
//
// Exotel only checks the HTTP status code of this response, so it is always
// 200 — a real failure here (bad DB, malformed payload) must not make Exotel
// retry or alarm on what is, from the telephony side, a call that already
// ended either way.
// ---------------------------------------------------------------------------

const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };

export default {
  fetch: async (req: Request) => {
    const url = new URL(req.url);
    const isCallbackPath = url.pathname.includes("/ivr-status-callback");

    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          ...CORS_HEADERS,
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        },
      });
    }

    if (!isCallbackPath) {
      return new Response("Not Found", { status: 404 });
    }

    try {
      const params = await readParams(req, url);
      const callSid = firstOf(params, "CallSid", "call_sid");
      const status = firstOf(params, "Status", "CallStatus", "status");
      const eventType = firstOf(params, "EventType", "event_type");

      console.log(
        `[ivr-status-callback] callSid=${callSid || "-"} status=${
          status || "-"
        } event=${eventType || "-"}`,
      );

      if (callSid && status) {
        // Capped like every other DB path here: a slow database must not turn
        // this into a hanging request, since Exotel does not need our reply
        // for anything beyond the status code.
        await withTimeout(
          recordStatusCallback({
            callSid,
            status,
            eventType: eventType || undefined,
            raw: paramsToObject(params),
          }),
          undefined,
          "recordStatusCallback",
        );
      } else {
        console.warn(
          "[ivr-status-callback] missing CallSid or Status; nothing recorded",
        );
      }

      return new Response(null, { status: 200, headers: CORS_HEADERS });
    } catch (err) {
      console.error("[ivr-status-callback] error:", err);
      return new Response(null, { status: 200, headers: CORS_HEADERS });
    }
  },
};
