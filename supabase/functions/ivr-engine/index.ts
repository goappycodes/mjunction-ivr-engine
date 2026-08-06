import "@supabase/functions-js/edge-runtime.d.ts";
import { startExotelCall, type ExotelCallRequest } from "./exotel.ts";
import {
  functionsUrl,
  lookupOrderById,
  startCallAttempt,
  transitionRecipientStatus,
  upsertCallLog,
} from "../_shared/orders.ts";
import { type LogLevel, logEvent } from "../_shared/logging.ts";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

function json(body: unknown, status: number) {
  return Response.json(body, { status, headers: JSON_HEADERS });
}

interface StartCallBody {
  orderId?: string;
  phoneNumber?: string;
  language?: string;
  statusCallbackUrl?: string;
  record?: boolean;
}

export default {
  fetch: async (req: Request) => {
    const startedAt = Date.now();
    // Populated as soon as parsing succeeds so every exit point below can log
    // it, even the ones that fail before orderId/phoneNumber are known.
    let bodyForLog: unknown = undefined;

    const log = (
      level: LogLevel,
      event: string,
      message: string,
      status: number,
      extra: Partial<Parameters<typeof logEvent>[0]> = {},
    ) =>
      logEvent({
        fn: "ivr-engine",
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

    try {
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

      let body: StartCallBody;
      try {
        body = await req.json();
        bodyForLog = body;
      } catch (_e) {
        log("warning", "invalid_json_body", "Request body is not valid JSON", 400);
        return json({ success: false, error: "Invalid JSON body" }, 400);
      }

      const orderId = body.orderId?.trim();
      if (!orderId) {
        log("warning", "order_id_missing", "orderId is required", 400);
        return json({ success: false, error: "orderId is required" }, 400);
      }

      // The order is the source of truth for the whole flow, so resolve it up
      // front. `phoneNumber` is optional: when omitted we dial the number on the
      // order record, which is the normal case for an outbound campaign.
      const { order, error: lookupError } = await lookupOrderById(orderId);

      // A failed query must not masquerade as a missing order — that made a
      // permission or schema fault look identical to a typo in the order id.
      if (lookupError) {
        log(
          "error",
          "order_lookup_failed",
          `Order lookup failed: ${lookupError}`,
          502,
          { orderId },
        );
        return json(
          { success: false, error: `Order lookup failed: ${lookupError}` },
          502,
        );
      }

      if (!order) {
        log("warning", "order_not_found", `Unknown orderId: ${orderId}`, 404, {
          orderId,
        });
        return json({
          success: false,
          error: `Unknown orderId: ${orderId}`,
          hint: "No row in public.recipients with this unique_id",
        }, 404);
      }

      const phoneNumber = body.phoneNumber?.trim() || order.phone_number;
      if (!phoneNumber) {
        log(
          "warning",
          "phone_number_missing",
          `Order ${orderId} has no phone_number`,
          422,
          { orderId },
        );
        return json(
          {
            success: false,
            error:
              `Order ${orderId} has no phone_number; pass phoneNumber explicitly`,
          },
          422,
        );
      }

      // The recipient is now "in a call" for order confirmation — bootstrap
      // it out of `imported` before the outcome is known, mirroring
      // recordOrderConfirmationCall's "ensure enqueued" step in mjunction.
      // Already-in-flight/retry recipients (order_confirm_pending,
      // order_unreachable) are left as-is; canTransition would reject moving
      // sideways into the same or a non-adjacent status anyway.
      if (order.status === "imported") {
        await transitionRecipientStatus({
          recipientId: order.recipient_id,
          from: order.status,
          to: "order_confirm_pending",
          payload: { via: "order_confirmation", reason: "call_initiated" },
        });
      }

      // Open the call_attempts row now, at dial time, rather than waiting for
      // the outcome — this is the row dynamic-greeting/update-order-status
      // finalize later, and it's what makes the recipient's status move
      // *during* the call instead of only once at the very end.
      const attempt = await startCallAttempt({
        recipientId: order.recipient_id,
        campaignId: order.campaign_id,
        callType: "order_confirmation",
      });

      const callRequest: ExotelCallRequest = {
        phoneNumber,
        orderId,
        language: body.language,
        // Default to this project's own status-callback function so a
        // recording URL / no-answer outcome is captured even when the caller
        // doesn't pass one explicitly.
        statusCallbackUrl: body.statusCallbackUrl ??
          functionsUrl("status-callback"),
        record: body.record,
      };

      const result = await startExotelCall(callRequest);

      // Record the CallSid to order + call_attempt mapping now, so later
      // steps can recover both from the CallSid alone. Awaited: the reply is
      // not latency-critical here and the mapping should exist before Exotel
      // starts hitting the applets.
      await upsertCallLog({
        callSid: result.providerCallRef,
        callerNumber: phoneNumber,
        orderId,
        step: "initiated",
        status: `CALL_${result.status.toUpperCase().replace(/-/g, "_")}`,
        callAttemptId: attempt?.id,
      });

      log(
        "success",
        "call_initiated",
        `Call ${result.providerCallRef} -> ${result.status}`,
        200,
        {
          orderId,
          callSid: result.providerCallRef,
          callerNumber: phoneNumber,
          body: { ...result, callAttemptId: attempt?.id, attemptNumber: attempt?.attemptNumber },
        },
      );

      return json({
        success: true,
        callSid: result.providerCallRef,
        status: result.status,
        orderId,
        phoneNumber,
      }, 200);
    } catch (error) {
      const message = (error as Error).message;

      // Missing configuration is a deployment fault, not a bad request.
      const status = message.startsWith("Missing required Exotel") ? 503 : 502;
      log("error", "unhandled_exception", message, status, {
        error: (error as Error).stack ?? message,
      });
      return json({ success: false, error: message }, status);
    }
  },
};
