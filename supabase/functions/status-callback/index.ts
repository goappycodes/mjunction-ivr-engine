import "@supabase/functions-js/edge-runtime.d.ts";
import {
  attachCallRecording,
  finalizeCallAttempt,
  getOpenCallAttemptByCallSid,
  getRecipientStatus,
  logCallStep,
  sealDeliveryVoc,
  terminalStatusOutcome,
  updateProviderStatus,
} from "../_shared/orders.ts";
import { logEvent } from "../_shared/logging.ts";
import { parseCustomField } from "../_shared/flow.ts";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

// ---------------------------------------------------------------------------
// Exotel `StatusCallback` receiver.
//
// `ivr-engine` subscribes every call to this URL's `terminal` event (see
// exotel.ts / StatusCallbackEvents[0]=terminal), so Exotel POSTs here once
// when a call reaches a final state (`completed`, `failed`, `busy`,
// `no-answer`), carrying `RecordingUrl` when the call was recorded and
// answered. Two independent jobs, both idempotent against repeat delivery:
//
//   1. Always attach the recording URL (+ CallSid) to the call's
//      call_attempts row, if Exotel sent one.
//   2. If that row was never finalized by the Gather flow (the call never
//      reached a menu — no-answer/busy/failed), finalize it now from the
//      terminal status alone, same as dynamic-greeting does for a call that
//      did complete the menu.
//
// Exotel does not gate the call on this response the way it does Gather/
// Connect applets, so there is no strict 5s budget here, but the same
// "never leave Exotel hanging" discipline still applies.
// ---------------------------------------------------------------------------

/**
 * Same dual body/query support as the other applet endpoints — Exotel's
 * StatusCallback is documented as a POST with form-encoded params, but query
 * params are honoured too so this is easy to hit manually while testing.
 */
async function readParams(req: Request, url: URL): Promise<URLSearchParams> {
  const params = new URLSearchParams(url.searchParams);

  if (req.method === "POST" || req.method === "PUT") {
    const contentType = req.headers.get("content-type") ?? "";
    try {
      if (contentType.includes("multipart/form-data")) {
        // Exotel's StatusCallback is sometimes delivered as multipart, not
        // form-urlencoded — req.text() + URLSearchParams can't parse that
        // (it silently produces one garbage key from the raw boundary text,
        // dropping CallSid entirely), so this needs the dedicated parser.
        const form = await req.formData();
        for (const [k, v] of form.entries()) {
          if (!params.has(k) && typeof v === "string") params.append(k, v);
        }
      } else {
        const raw = await req.text();
        if (raw) {
          if (contentType.includes("application/json")) {
            for (const [k, v] of Object.entries(JSON.parse(raw))) {
              if (!params.has(k)) params.append(k, String(v));
            }
          } else {
            for (const [k, v] of new URLSearchParams(raw)) {
              if (!params.has(k)) params.append(k, v);
            }
          }
        }
      }
    } catch (_e) {
      console.warn("[status-callback] unparseable body ignored");
    }
  }

  return params;
}

function firstOf(params: URLSearchParams, ...keys: string[]): string {
  for (const key of keys) {
    const value = params.get(key);
    if (value) return value.trim();
  }
  return "";
}

export default {
  fetch: async (req: Request) => {
    const startedAt = Date.now();
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        },
      });
    }

    try {
      const params = await readParams(req, url);
      const allParams = Object.fromEntries(params.entries());
      const callSid = firstOf(params, "CallSid", "call_sid");
      // CustomField carries the flow suffix as well as the order id; only the
      // id is wanted here (the call's own call_attempts row is the
      // authoritative record of which script ran).
      const { orderId } = parseCustomField(
        firstOf(params, "CustomField", "custom_field"),
      );
      const exotelStatus = firstOf(params, "Status", "CallStatus", "status");
      const recordingUrl = firstOf(params, "RecordingUrl", "recording_url");
      const durationRaw = firstOf(params, "Duration", "DialCallDuration", "duration");
      // Exotel StatusCallback sends Duration in seconds (same as Call Details API).
      const duration = durationRaw && /^\d+$/.test(durationRaw)
        ? Number(durationRaw)
        : null;

      if (!callSid) {
        logEvent({
          fn: "status-callback",
          level: "warning",
          event: "call_sid_missing",
          message: "StatusCallback arrived with no CallSid — cannot attribute it",
          method: req.method,
          url: req.url,
          params: allParams,
          status: 200,
          durationMs: Date.now() - startedAt,
        });
        // Still 200 — Exotel does not retry on a non-2xx here, and there is
        // nothing actionable to retry towards anyway.
        return Response.json({ received: true, note: "no CallSid" }, {
          status: 200,
          headers: JSON_HEADERS,
        });
      }

      logCallStep({
        callSid,
        orderId,
        step: "status_callback",
        status: `PROVIDER_${(exotelStatus || "UNKNOWN").toUpperCase().replace(/-/g, "_")}`,
        appletHint: `status_callback (duration=${duration || "?"}s, recording=${recordingUrl ? "yes" : "no"})`,
      });

      const attempt = await getOpenCallAttemptByCallSid(callSid);
      if (!attempt) {
        logEvent({
          fn: "status-callback",
          level: "warning",
          event: "call_attempt_not_found",
          message: `No call_attempts row for callSid=${callSid}`,
          method: req.method,
          url: req.url,
          params: allParams,
          status: 200,
          callSid,
          orderId,
          durationMs: Date.now() - startedAt,
        });
        return Response.json({ received: true, note: "no call attempt" }, {
          status: 200,
          headers: JSON_HEADERS,
        });
      }

      // Unconditional: a "completed" status with no recording and no
      // outcome change is still a real telephony status worth showing in
      // mjunction's call log.
      if (exotelStatus) {
        await updateProviderStatus(attempt.id, exotelStatus);
      }

      // Always persist callSid and duration regardless of whether a recording
      // was captured — no-answer/busy/failed calls carry no RecordingUrl but
      // still produce a meaningful callSid and duration that belong on the row.
      await attachCallRecording({
        callAttemptId: attempt.id,
        recipientId: attempt.recipientId,
        recordingUrl: recordingUrl || null,
        providerCallRef: callSid,
        durationSeconds: duration,
      });

      // Attempt VOC sealing for every delivery_confirmation callback —
      // sealDeliveryVoc reads recording_url from the DB (not from the
      // webhook params), so it succeeds even when this callback carries no
      // RecordingUrl, as long as a previous operation already persisted one.
      // The function is idempotent: it no-ops if already sealed or if the DB
      // row still has no recording_url.
      if (attempt.callType === "delivery_confirmation") {
        await sealDeliveryVoc(attempt.id);
      }

      // Only finalize from the terminal status when the Gather flow never
      // did it first — never overwrite a real outcome with a generic one.
      if (!attempt.outcome) {
        const mapped = terminalStatusOutcome(exotelStatus);
        if (mapped) {
          const status = await getRecipientStatus(attempt.recipientId);
          if (status) {
            await finalizeCallAttempt({
              callAttemptId: attempt.id,
              recipientId: attempt.recipientId,
              from: status,
              callType: attempt.callType,
              attemptNumber: attempt.attemptNumber,
              outcome: mapped,
              dtmfResponse: null,
            });
          }
        }
      }

      logEvent({
        fn: "status-callback",
        level: "success",
        event: "status_callback_processed",
        message:
          `callSid=${callSid} status=${exotelStatus || "?"} recording=${recordingUrl ? "captured" : "none"}` +
          (attempt.outcome ? " (already finalized)" : ""),
        method: req.method,
        url: req.url,
        params: allParams,
        status: 200,
        callSid,
        orderId,
        durationMs: Date.now() - startedAt,
      });

      return Response.json({ received: true }, { status: 200, headers: JSON_HEADERS });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent({
        fn: "status-callback",
        level: "error",
        event: "unhandled_exception",
        message,
        method: req.method,
        url: req.url,
        status: 200,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        durationMs: Date.now() - startedAt,
      });
      // Still 200: this is a fire-and-forget receiver, not a Gather applet —
      // there is no caller waiting on a specific error contract here.
      return Response.json({ received: true, error: message }, {
        status: 200,
        headers: JSON_HEADERS,
      });
    }
  },
};
