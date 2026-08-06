import "@supabase/functions-js/edge-runtime.d.ts";
import { DTMF_STATUS_MAP, updateOrderStatus } from "../_shared/orders.ts";
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
   * Explicit status set by non-keypress triggers (e.g. connect-support marking
   * the order `issue_raised`). Takes precedence over `dtmf` when both are sent.
   */
  status?: string;
}

// ---------------------------------------------------------------------------
// Sole responsibility of this function: given an order id and a DTMF digit,
// write the resulting status to `orders`. It does not resolve orders, does
// not talk to Exotel, and does not touch `ivr_logs` / `ivr_call_events` —
// dynamic-greeting already owns all of that. Keeping the write isolated here
// means it can be redeployed, retried, or re-authored without touching the
// live call flow.
//
// This is called by dynamic-greeting as a fire-and-forget request, but it
// still has to respond quickly and correctly on its own: if it is ever
// called directly (manual retry, admin tooling), the same 5-second-budget
// discipline applies — one DB round trip, no chained lookups.
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
    const explicitStatus = body.status?.trim() ?? "";

    if (!orderId) {
      log("warning", "order_id_missing", "orderId is required", 400);
      return json({ success: false, error: "orderId is required" }, 400);
    }
    if (!dtmf && !explicitStatus) {
      log(
        "warning",
        "dtmf_or_status_missing",
        "dtmf or status is required",
        400,
        { orderId, callSid, callerNumber },
      );
      return json(
        { success: false, error: "dtmf or status is required" },
        400,
      );
    }

    // An explicit status wins; otherwise map the keypress. This is what lets
    // connect-support set `issue_raised` on transfer while the greeting flow
    // keeps mapping 1/2 to confirmed/support_requested.
    const status = explicitStatus || DTMF_STATUS_MAP[dtmf];
    if (!status) {
      // Not a hard failure — just nothing for this endpoint to do with a
      // digit outside 1/2. Logged so an unexpected digit shape is visible
      // without failing the caller.
      log(
        "warning",
        "unhandled_dtmf",
        `Unhandled dtmf value: ${dtmf}`,
        200,
        { orderId, callSid, callerNumber },
      );
      return json({ success: false, error: `Unhandled dtmf value: ${dtmf}` }, 200);
    }

    try {
      const result = await updateOrderStatus(orderId, status);

      if (!result.success) {
        const notFound = result.error?.startsWith("Order not found");
        log(
          "error",
          "update_failed",
          `Update failed: ${result.error}`,
          notFound ? 404 : 500,
          { orderId, callSid, callerNumber },
        );
        return json({ success: false, error: result.error }, notFound ? 404 : 500);
      }

      log(
        "success",
        "status_updated",
        `order=${orderId} -> status=${status}`,
        200,
        { orderId, callSid, callerNumber },
      );

      return json({ success: true }, 200);
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
