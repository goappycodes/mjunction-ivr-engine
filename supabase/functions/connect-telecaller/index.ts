import "@supabase/functions-js/edge-runtime.d.ts";
import { logCallStep, notifyOrderStatusUpdate } from "../_shared/orders.ts";
import { logEvent } from "../_shared/logging.ts";
import { type ConnectContext, resolveConnectConfig } from "./config.ts";
import { buildConnectResponse } from "../_shared/connect.ts";
import { parseCustomField } from "../_shared/flow.ts";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  // Exotel must re-fetch every time; a cached body could dial a stale number.
  "Cache-Control": "no-store",
};

// ---------------------------------------------------------------------------
// Connect applet — Dynamic URL endpoint for the address-issue transfer.
//
// Wired to the Connect applet on the address Gather's "incorrect" (Case 2)
// branch, right after its Greeting. Exotel GETs this mid-call and expects a
// JSON body telling it whom to dial — here, the telecaller assigned to this
// order (`recipients.telecaller_phone`), so the caller ends up talking to the
// same person who owns their delivery instead of a generic support line.
// Same 5-second budget as every other applet endpoint: one DB lookup, no
// chained queries, never return a non-200 on the happy path.
// ---------------------------------------------------------------------------

/**
 * Exotel sends applet params on the GET query string. POST is accepted too so
 * the endpoint stays testable; query params win over body on any clash.
 */
async function readParams(req: Request, url: URL): Promise<URLSearchParams> {
  const params = new URLSearchParams(url.searchParams);

  if (req.method === "POST" || req.method === "PUT") {
    const raw = await req.text();
    if (raw) {
      const contentType = req.headers.get("content-type") ?? "";
      try {
        if (contentType.includes("application/json")) {
          for (const [k, v] of Object.entries(JSON.parse(raw))) {
            if (!params.has(k)) params.append(k, String(v));
          }
        } else {
          for (const [k, v] of new URLSearchParams(raw)) {
            if (!params.has(k)) params.append(k, v);
          }
        }
      } catch (_e) {
        console.warn("[connect-telecaller] unparseable body ignored");
      }
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

    try {
      if (req.method === "OPTIONS") {
        logEvent({
          fn: "connect-telecaller",
          level: "success",
          event: "options_preflight",
          message: "CORS preflight",
          method: req.method,
          url: req.url,
          status: 200,
          durationMs: Date.now() - startedAt,
        });
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          },
        });
      }

      const params = await readParams(req, url);
      const allParams = Object.fromEntries(params.entries());
      const callSid = firstOf(params, "CallSid", "call_sid");
      const callerNumber = firstOf(params, "CallFrom", "From", "caller_number");
      // Strip the flow suffix — the destination is the order's assigned
      // telecaller either way, so this endpoint is identical for both
      // scripts: an address problem and a delivered-item problem both reach
      // the same person.
      const { orderId } = parseCustomField(
        firstOf(params, "CustomField", "custom_field"),
      );

      const ctx: ConnectContext = { orderId, callSid, callerNumber };
      const config = await resolveConnectConfig(ctx);

      // A Connect response with no numbers is meaningless — Exotel would have
      // nothing to dial. Fail loudly with a non-200 so the misconfiguration is
      // visible in Exotel (which can then run its configured fallback URL)
      // rather than silently bridging the caller to dead air.
      if (config.numbers.length === 0) {
        logEvent({
          fn: "connect-telecaller",
          level: "error",
          event: "no_telecaller_number",
          message:
            "No telecaller phone on file for this order and no fallback SUPPORT_NUMBER configured",
          method: req.method,
          url: req.url,
          params: allParams,
          status: 500,
          callSid,
          callerNumber,
          orderId,
          durationMs: Date.now() - startedAt,
        });
        logCallStep({
          callSid,
          callerNumber,
          orderId,
          step: "connect_telecaller",
          status: "TELECALLER_CONNECT_NO_NUMBER",
          appletHint: "connect (dynamic-url)",
        });
        return Response.json(
          { error: "No telecaller phone configured for this order" },
          { status: 500, headers: JSON_HEADERS },
        );
      }

      const responseBody = buildConnectResponse(config);

      logCallStep({
        callSid,
        callerNumber,
        orderId,
        step: "connect_telecaller",
        status: "TELECALLER_CONNECT_SERVED",
        appletHint: "connect (dynamic-url)",
      });

      // Record the transfer as this call's outcome — same escalations queue
      // the order-level "press 2" transfer already lands in
      // (`call_attempts.outcome = 'transferred_to_agent'`), since both cases
      // need a human to resolve before the order can proceed. Fire-and-forget
      // through update-order-status so it never eats into Exotel's 5s budget.
      if (orderId) {
        notifyOrderStatusUpdate({
          orderId,
          callSid,
          callerNumber,
          outcome: "transferred_to_agent",
        });
      }

      logEvent({
        fn: "connect-telecaller",
        level: "success",
        event: "connect_served",
        message: `Dialing ${config.numbers.join(",")} ` +
          `(ring=${config.maxRingingDuration}s max=${config.maxConversationDuration}s ` +
          `record=${config.record})`,
        method: req.method,
        url: req.url,
        params: allParams,
        status: 200,
        body: responseBody,
        callSid,
        callerNumber,
        orderId,
        durationMs: Date.now() - startedAt,
      });

      return Response.json(responseBody, {
        status: 200,
        headers: JSON_HEADERS,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent({
        fn: "connect-telecaller",
        level: "error",
        event: "unhandled_exception",
        message,
        method: req.method,
        url: req.url,
        status: 500,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        durationMs: Date.now() - startedAt,
      });
      // Non-200 so Exotel does not try to bridge on a broken body.
      return Response.json(
        { error: "Internal Server Error" },
        { status: 500, headers: JSON_HEADERS },
      );
    }
  },
};
