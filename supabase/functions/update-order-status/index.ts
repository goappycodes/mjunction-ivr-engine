import "@supabase/functions-js/edge-runtime.d.ts";
import { DTMF_STATUS_MAP, updateOrderStatus } from "../_shared/orders.ts";

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

    let body: UpdateOrderStatusBody;
    try {
      body = await req.json();
    } catch (_e) {
      return json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const orderId = body.orderId?.trim();
    const callSid = body.callSid?.trim() ?? "";
    const callerNumber = body.callerNumber?.trim() ?? "";
    const dtmf = body.dtmf?.trim() ?? "";

    if (!orderId) {
      return json({ success: false, error: "orderId is required" }, 400);
    }
    if (!dtmf) {
      return json({ success: false, error: "dtmf is required" }, 400);
    }

    const status = DTMF_STATUS_MAP[dtmf];
    if (!status) {
      // Not a hard failure — just nothing for this endpoint to do with a
      // digit outside 1/2. Logged so an unexpected digit shape is visible
      // without failing the caller.
      console.warn(
        `[update-order-status] unhandled dtmf="${dtmf}" order=${orderId} callSid=${callSid || "-"}`,
      );
      return json({ success: false, error: `Unhandled dtmf value: ${dtmf}` }, 200);
    }

    try {
      const result = await updateOrderStatus(orderId, status);

      if (!result.success) {
        console.error(
          `[update-order-status] update failed order=${orderId} callSid=${callSid || "-"} error=${result.error}`,
        );
        const notFound = result.error?.startsWith("Order not found");
        return json({ success: false, error: result.error }, notFound ? 404 : 500);
      }

      console.log(
        `[update-order-status] order=${orderId} callSid=${callSid || "-"} ` +
          `caller=${callerNumber || "-"} dtmf=${dtmf} -> status=${status}`,
      );

      return json({ success: true }, 200);
    } catch (err) {
      console.error("[update-order-status] unexpected error:", err);
      return json({ success: false, error: "Internal server error" }, 500);
    }
  },
};
