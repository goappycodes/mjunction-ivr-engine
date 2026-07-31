import "@supabase/functions-js/edge-runtime.d.ts";
import { startExotelCall, type ExotelCallRequest } from "./exotel.ts";
import { getOrderById, upsertCallLog } from "../_shared/orders.ts";

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
    try {
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
        return json({ success: false, error: "Method not allowed" }, 405);
      }

      let body: StartCallBody;
      try {
        body = await req.json();
      } catch (_e) {
        return json({ success: false, error: "Invalid JSON body" }, 400);
      }

      const orderId = body.orderId?.trim();
      if (!orderId) {
        return json({ success: false, error: "orderId is required" }, 400);
      }

      // The order is the source of truth for the whole flow, so resolve it up
      // front. `phoneNumber` is optional: when omitted we dial the number on the
      // order record, which is the normal case for an outbound campaign.
      const order = await getOrderById(orderId);
      if (!order) {
        return json(
          { success: false, error: `Unknown orderId: ${orderId}` },
          404,
        );
      }

      const phoneNumber = body.phoneNumber?.trim() || order.phone_number;
      if (!phoneNumber) {
        return json(
          {
            success: false,
            error:
              `Order ${orderId} has no phone_number; pass phoneNumber explicitly`,
          },
          422,
        );
      }

      const callRequest: ExotelCallRequest = {
        phoneNumber,
        orderId,
        language: body.language,
        statusCallbackUrl: body.statusCallbackUrl,
        record: body.record,
      };

      const result = await startExotelCall(callRequest);

      // Record the CallSid to order mapping now, so dynamic-greeting can recover
      // the order id from the CallSid alone if a given applet request arrives
      // without CustomField. Awaited: the reply is not latency-critical here and
      // the mapping should exist before Exotel starts hitting the applets.
      await upsertCallLog({
        callSid: result.providerCallRef,
        callerNumber: phoneNumber,
        orderId,
        step: "initiated",
        status: `CALL_${result.status.toUpperCase().replace(/-/g, "_")}`,
      });

      return json({
        success: true,
        callSid: result.providerCallRef,
        status: result.status,
        orderId,
        phoneNumber,
      }, 200);
    } catch (error) {
      const message = (error as Error).message;
      console.error("Error in ivr-engine:", message);

      // Missing configuration is a deployment fault, not a bad request.
      const status = message.startsWith("Missing required Exotel") ? 503 : 502;
      return json({ success: false, error: message }, status);
    }
  },
};
