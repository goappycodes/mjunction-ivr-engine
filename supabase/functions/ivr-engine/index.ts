import "@supabase/functions-js/edge-runtime.d.ts";
import { startExotelCall, type ExotelCallRequest } from "./exotel.ts";
import {
  functionsUrl,
  hasActiveCallForPhone,
  lookupOrderById,
  startCallAttempt,
  transitionRecipientStatus,
  updateProviderStatus,
  upsertCallLog,
} from "../_shared/orders.ts";
import { type LogLevel, logEvent } from "../_shared/logging.ts";
import {
  type CallFlow,
  DELIVERY_CALLABLE,
  encodeCustomField,
  ORDER_CALLABLE,
} from "../_shared/flow.ts";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

function json(body: unknown, status: number) {
  return Response.json(body, { status, headers: JSON_HEADERS });
}

interface StartCallBody {
  orderId?: string;
  /**
   * Which script to run. Defaults to `order_confirmation` so every existing
   * caller keeps working unchanged. Both run on the same Exotel app — see
   * `_shared/flow.ts`.
   */
  callType?: CallFlow;
  phoneNumber?: string;
  language?: string;
  statusCallbackUrl?: string;
  record?: boolean;
}

/**
 * The recipient statuses each script is valid for, and the status a call
 * bootstraps the recipient into before its outcome is known. Mirrors
 * `recordOrderConfirmationCall`'s "ensure enqueued" step in mjunction, and the
 * equivalent `delivered -> delivery_confirm_pending` move for the second half
 * of the pipeline. Recipients already in flight (…_pending) or being retried
 * (…_unreachable) are left alone; canTransition would reject a sideways move
 * anyway.
 */
const FLOW_RULES: Record<
  CallFlow,
  { callable: string[]; bootstrapFrom: string; bootstrapTo: string; label: string }
> = {
  order_confirmation: {
    callable: [...ORDER_CALLABLE],
    bootstrapFrom: "imported",
    bootstrapTo: "order_confirm_pending",
    label: "order confirmation",
  },
  delivery_confirmation: {
    // `delivered` is included so a single call can both enqueue the recipient
    // and run the confirmation, matching how "Mark as delivered" then "Run
    // confirmation call" behaves in the admin panel — without forcing the
    // caller to make two requests.
    callable: [...DELIVERY_CALLABLE, "delivered"],
    bootstrapFrom: "delivered",
    bootstrapTo: "delivery_confirm_pending",
    label: "delivery confirmation",
  },
};

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

      // This endpoint places a real, billed outbound call — verify_jwt is
      // off for all functions in this project (see supabase/config.toml), so
      // without this check anyone who can reach the Functions URL could
      // trigger a call. A shared secret, not a JWT, because the caller is
      // mjunction's server (no end-user session to verify).
      const expectedSecret = Deno.env.get("IVR_SHARED_SECRET");
      const providedSecret = req.headers.get("x-ivr-shared-secret");
      if (!expectedSecret || providedSecret !== expectedSecret) {
        log("warning", "unauthorized", "Missing or invalid x-ivr-shared-secret", 401);
        return json({ success: false, error: "Unauthorized" }, 401);
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

      const callType: CallFlow = body.callType ?? "order_confirmation";
      const rules = FLOW_RULES[callType];
      if (!rules) {
        log("warning", "call_type_invalid", `Unknown callType: ${body.callType}`, 400, { orderId });
        return json(
          {
            success: false,
            error: `Unknown callType: ${body.callType}`,
            hint: "Expected 'order_confirmation' or 'delivery_confirmation'",
          },
          400,
        );
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

      // Refuse to run the wrong script at the wrong point in the pipeline —
      // a delivery-confirmation call to someone whose address isn't confirmed
      // yet would ask them to confirm a delivery that was never dispatched.
      // Checked here rather than trusted from the caller because this
      // endpoint places a real, billed call.
      if (!rules.callable.includes(order.status)) {
        log(
          "warning",
          "status_not_callable",
          `Order ${orderId} is ${order.status}; not eligible for ${rules.label}`,
          409,
          { orderId },
        );
        return json(
          {
            success: false,
            error:
              `Order ${orderId} is in status "${order.status}", which is not eligible for a ${rules.label} call`,
            hint: `Eligible statuses: ${rules.callable.join(", ")}`,
          },
          409,
        );
      }

      // Refuse to place a second call to a number that's already mid-call.
      // Phone numbers are no longer unique per recipient (mjunction's import
      // stopped deduping on phone), so this is checked by phone rather than
      // by this one order/recipient — Exotel can only ever have one real
      // active call to a given number regardless of which order it's for.
      if (await hasActiveCallForPhone(phoneNumber)) {
        log(
          "warning",
          "phone_already_in_call",
          `Refused: ${phoneNumber} already has a call in progress`,
          409,
          { orderId, callerNumber: phoneNumber },
        );
        return json(
          {
            success: false,
            error: `${phoneNumber} already has a call in progress`,
            hint: "Wait for the current call to finish before placing another to the same number",
          },
          409,
        );
      }

      // The recipient is now "in a call" — bootstrap it into the pending
      // status before the outcome is known, mirroring
      // recordOrderConfirmationCall's "ensure enqueued" step in mjunction.
      // Already-in-flight/retry recipients are left as-is; canTransition
      // would reject moving sideways into the same or a non-adjacent status
      // anyway.
      if (order.status === rules.bootstrapFrom) {
        await transitionRecipientStatus({
          recipientId: order.recipient_id,
          from: order.status,
          to: rules.bootstrapTo as typeof order.status,
          payload: { via: callType, reason: "call_initiated" },
        });
      }

      // Open the call_attempts row now, at dial time, rather than waiting for
      // the outcome — this is the row dynamic-greeting/update-order-status
      // finalize later, and it's what makes the recipient's status move
      // *during* the call instead of only once at the very end.
      const attempt = await startCallAttempt({
        recipientId: order.recipient_id,
        callType,
      });

      const callRequest: ExotelCallRequest = {
        phoneNumber,
        customField: encodeCustomField(orderId, callType),
        language: body.language,
        // Default to this project's own status-callback function so a
        // recording URL / no-answer outcome is captured even when the caller
        // doesn't pass one explicitly.
        statusCallbackUrl: body.statusCallbackUrl ??
          functionsUrl("status-callback"),
        // Default to true: without a recording, status-callback has no
        // RecordingUrl to attach and the whole point of that function is
        // moot. Still overridable per-call with an explicit `record: false`.
        record: body.record ?? true,
      };

      const result = await startExotelCall(callRequest);

      // Show a real telephony status (e.g. "queued") in mjunction's call log
      // immediately, before any outcome exists.
      if (attempt?.id) {
        await updateProviderStatus(attempt.id, result.status);
      }

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
        callType,
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
