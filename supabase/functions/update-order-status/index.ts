import "@supabase/functions-js/edge-runtime.d.ts";
import {
  type CallOutcome,
  finalizeCallAttempt,
  getOpenCallAttemptByCallSid,
  getPriorStepInput,
  getRecipientStatus,
  resolveOrderConfirmationOutcome,
} from "../_shared/orders.ts";
import { type LogLevel, logEvent } from "../_shared/logging.ts";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: JSON_HEADERS });
}

interface UpdateOrderStatusBody {
  orderId?: string;
  callSid?: string;
  callerNumber?: string;
  dtmf?: string;
  /**
   * Explicit outcome set by non-keypress triggers (e.g. connect-support
   * marking the call `transferred_to_agent`). Takes precedence over `dtmf`.
   */
  outcome?: string;
}

// ---------------------------------------------------------------------------
// Sole responsibility of this function: given a call_sid and either a DTMF
// digit or an explicit outcome, finalize the call_attempts row it belongs to
// and apply the resulting recipient status. It does not resolve recipients
// from scratch, does not talk to Exotel, and does not touch `ivr_logs` /
// `ivr_call_events` — dynamic-greeting already owns all of that. Keeping the
// write isolated here means it can be redeployed, retried, or re-authored
// without touching the live call flow.
//
// This is called by dynamic-greeting/connect-support as a fire-and-forget
// request, but it still has to respond quickly and correctly on its own: if
// it is ever called directly (manual retry, admin tooling), the same
// 5-second-budget discipline applies — a couple of DB round trips at most.
// ---------------------------------------------------------------------------

export default {
  fetch: async (req: Request) => {
    const startedAt = Date.now();
    let bodyForLog: unknown = undefined;

    const log = (
      level: LogLevel,
      event: string,
      message: string,
      status: number,
      extra: Partial<Parameters<typeof logEvent>[0]> = {},
    ) =>
      logEvent({
        fn: "update-order-status",
        level,
        event,
        message,
        method: req.method,
        url: req.url,
        params: bodyForLog as Record<string, unknown> | undefined,
        status,
        durationMs: Date.now() - startedAt,
        ...extra,
      });

    if (req.method === "OPTIONS") {
      log("success", "options_preflight", "CORS preflight", 200);
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
        },
      });
    }

    if (req.method !== "POST") {
      log("warning", "method_not_allowed", `${req.method} not allowed`, 405);
      return json({ success: false, error: "Method not allowed" }, 405);
    }

    let body: UpdateOrderStatusBody;
    try {
      body = await req.json();
      bodyForLog = body;
    } catch (_e) {
      log("warning", "invalid_json_body", "Request body is not valid JSON", 400);
      return json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const orderId = body.orderId?.trim();
    const callSid = body.callSid?.trim() ?? "";
    const callerNumber = body.callerNumber?.trim() ?? "";
    const dtmf = body.dtmf?.trim() ?? "";
    const explicitOutcome = (body.outcome?.trim() ?? "") as CallOutcome | "";

    if (!orderId) {
      log("warning", "order_id_missing", "orderId is required", 400);
      return json({ success: false, error: "orderId is required" }, 400);
    }
    if (!callSid) {
      log("warning", "call_sid_missing", "callSid is required", 400, { orderId });
      return json({ success: false, error: "callSid is required" }, 400);
    }
    if (!dtmf && !explicitOutcome) {
      log(
        "warning",
        "dtmf_or_outcome_missing",
        "dtmf or outcome is required",
        400,
        { orderId, callSid, callerNumber },
      );
      return json(
        { success: false, error: "dtmf or outcome is required" },
        400,
      );
    }

    try {
      // Recover the call_attempts row `ivr-engine` opened when it placed this
      // call. No row means either a very old call (placed before this
      // function existed) or a mid-call error upstream — not this function's
      // fault, and not worth failing loudly over since nothing here has
      // anything to attach the update to.
      const attempt = await getOpenCallAttemptByCallSid(callSid);
      if (!attempt) {
        log(
          "warning",
          "call_attempt_not_found",
          `No open call_attempts row for callSid=${callSid}`,
          200,
          { orderId, callSid, callerNumber },
        );
        return json(
          { success: false, error: `No open call attempt for callSid: ${callSid}` },
          200,
        );
      }

      // Idempotency: Exotel/dynamic-greeting can plausibly deliver this
      // notification more than once for the same call (a retried fetch, a
      // second menu press somehow reaching the same terminal step). Once a
      // call_attempts row has an outcome it is done — finalizing again would
      // duplicate its `call_attempt` timeline event without changing anything
      // real.
      if (attempt.outcome) {
        log(
          "success",
          "already_finalized",
          `callSid=${callSid} already finalized as ${attempt.outcome} — skipped`,
          200,
          { orderId, callSid, callerNumber },
        );
        return json({ success: true, outcome: attempt.outcome, note: "already finalized" }, 200);
      }

      const status = await getRecipientStatus(attempt.recipientId);
      if (!status) {
        log("error", "recipient_not_found", `orderId=${orderId} resolved no recipient`, 404, {
          orderId,
          callSid,
          callerNumber,
        });
        return json({ success: false, error: `Recipient not found: ${orderId}` }, 404);
      }

      // An explicit outcome (connect-support's transfer) wins outright. Only
      // a keypress needs the extra lookup: the address-menu digit alone is
      // ambiguous without the welcome-menu digit from the previous step (see
      // resolveOrderConfirmationOutcome), so that read only happens on this
      // path, which is already off Exotel's response critical path.
      const outcome: CallOutcome = explicitOutcome ||
        resolveOrderConfirmationOutcome(
          await getPriorStepInput(callSid, "address"),
          dtmf,
        );

      await finalizeCallAttempt({
        callAttemptId: attempt.id,
        recipientId: attempt.recipientId,
        from: status,
        callType: attempt.callType,
        attemptNumber: attempt.attemptNumber,
        outcome,
        dtmfResponse: dtmf || null,
      });

      log(
        "success",
        "call_finalized",
        `order=${orderId} callSid=${callSid} -> outcome=${outcome}`,
        200,
        { orderId, callSid, callerNumber },
      );

      return json({ success: true, outcome }, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", "unhandled_exception", message, 500, {
        orderId,
        callSid,
        callerNumber,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      return json({ success: false, error: "Internal server error" }, 500);
    }
  },
};
