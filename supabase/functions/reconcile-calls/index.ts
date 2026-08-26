import "@supabase/functions-js/edge-runtime.d.ts";
import { getCallDetails } from "../_shared/exotel.ts";
import {
  attachCallRecording,
  finalizeCallAttempt,
  getRecipientStatus,
  getStaleOpenCallAttempts,
  sealDeliveryVoc,
  terminalStatusOutcome,
  updateProviderStatus,
} from "../_shared/orders.ts";
import { logEvent } from "../_shared/logging.ts";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

// ---------------------------------------------------------------------------
// Fallback for a missed/delayed Exotel StatusCallback — exactly the gap
// Exotel's own webhook documentation calls out:
//
//   "StatusCallback delivery may be delayed or fail due to network issues,
//   server problems, or webhook downtime. Implement fallback logic using the
//   Call Details API to ensure you capture all call data."
//
// status-callback/index.ts is the primary, push-based path. This is the
// pull-based backstop: find call_attempts rows that look stuck (see
// getStaleOpenCallAttempts for the exact definition), ask Exotel's Call
// Details API directly, and run the same finalize/attach-recording/
// seal-VOC logic status-callback would have run if its webhook had arrived.
//
// Safe to run repeatedly and concurrently with status-callback itself:
// finalizeCallAttempt only transitions a recipient once outcome is null,
// sealDeliveryVoc no-ops once a VOC already exists, and attachCallRecording
// is a plain overwrite of the same fields status-callback would have set.
// Whichever path reaches a given call first "wins"; the other is a no-op.
// ---------------------------------------------------------------------------

interface ReconcileResult {
  scanned: number;
  finalized: number;
}

async function reconcile(): Promise<ReconcileResult> {
  const stale = await getStaleOpenCallAttempts({
    // Give Exotel's own webhook a fair chance to arrive first.
    olderThanMinutes: 10,
    // Stop retrying a call that can apparently never resolve.
    newerThanHours: 24,
    limit: 50,
  });

  let finalized = 0;

  for (const attempt of stale) {
    try {
      const details = await getCallDetails(attempt.callSid);
      if (!details) continue;

      await updateProviderStatus(attempt.id, details.status);

      if (details.recordingUrl) {
        await attachCallRecording({
          callAttemptId: attempt.id,
          recipientId: attempt.recipientId,
          recordingUrl: details.recordingUrl,
          providerCallRef: attempt.callSid,
          durationSeconds: details.durationSeconds,
        });

        if (attempt.callType === "delivery_confirmation") {
          await sealDeliveryVoc(attempt.id);
        }
      }

      const mapped = terminalStatusOutcome(details.status);
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
          finalized++;
        }
      }

      logEvent({
        fn: "reconcile-calls",
        level: "success",
        event: "call_reconciled",
        message: `callSid=${attempt.callSid} status=${details.status} recording=${
          details.recordingUrl ? "captured" : "none"
        }${mapped ? ` outcome=${mapped}` : ""}`,
        callSid: attempt.callSid,
        status: 200,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent({
        fn: "reconcile-calls",
        level: "error",
        event: "reconcile_call_failed",
        message,
        callSid: attempt.callSid,
        status: 500,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
    }
  }

  return { scanned: stale.length, finalized };
}

// Self-scheduling: fires every 5 minutes once this function is deployed, no
// external cron wiring required. `Deno.cron` needs edge_runtime policy
// "per_worker" (already set in supabase/config.toml) and only runs on the
// deployed function, not under `supabase functions serve` locally — that's
// fine, this is a production backstop, not something local dev depends on.
Deno.cron("reconcile-stale-calls", "*/5 * * * *", async () => {
  const result = await reconcile();
  logEvent({
    fn: "reconcile-calls",
    level: "success",
    event: "cron_run_complete",
    message: `scanned=${result.scanned} finalized=${result.finalized}`,
    status: 200,
  });
});

export default {
  fetch: async (req: Request) => {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
        },
      });
    }

    if (req.method !== "POST") {
      return Response.json({ success: false, error: "Method not allowed" }, {
        status: 405,
        headers: JSON_HEADERS,
      });
    }

    // Same shared-secret posture as ivr-engine: this writes real recipient
    // status transitions and can seal a VOC, so it isn't left open to the
    // public internet just because it doesn't place a call itself. Lets you
    // also trigger it manually for testing, or wire an external scheduler to
    // it instead of/alongside the Deno.cron above.
    const expectedSecret = Deno.env.get("IVR_SHARED_SECRET");
    const providedSecret = req.headers.get("x-ivr-shared-secret");
    if (!expectedSecret || providedSecret !== expectedSecret) {
      return Response.json({ success: false, error: "Unauthorized" }, {
        status: 401,
        headers: JSON_HEADERS,
      });
    }

    try {
      // Debug mode: POST with { "callSid": "xxx" } to inspect what Exotel's
      // Call Details API returns for a specific call without touching the DB.
      // Useful for diagnosing missing RecordingUrl on already-finalized calls
      // that reconcile() skips (it only processes outcome IS NULL rows).
      let body: Record<string, unknown> = {};
      try {
        const text = await req.text();
        if (text) body = JSON.parse(text);
      } catch (_) { /* empty body is fine */ }

      if (typeof body.callSid === "string" && body.callSid.trim()) {
        const callSid = body.callSid.trim();
        const details = await getCallDetails(callSid);
        return Response.json({
          success: true,
          debug: true,
          callSid,
          exotel: details
            ? {
                status: details.status,
                recordingUrl: details.recordingUrl,
                durationSeconds: details.durationSeconds,
                hasRecording: !!details.recordingUrl,
              }
            : null,
          note: details
            ? details.recordingUrl
              ? "Exotel HAS a recording — needs to be backfilled into DB"
              : "Exotel has NO recording for this call — Record param may not be working"
            : "Exotel Call Details API returned null — check credentials or invalid CallSid",
        }, { status: 200, headers: JSON_HEADERS });
      }

      const result = await reconcile();
      return Response.json({ success: true, ...result }, {
        status: 200,
        headers: JSON_HEADERS,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent({
        fn: "reconcile-calls",
        level: "error",
        event: "unhandled_exception",
        message,
        status: 500,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      return Response.json({ success: false, error: message }, {
        status: 500,
        headers: JSON_HEADERS,
      });
    }
  },
};
