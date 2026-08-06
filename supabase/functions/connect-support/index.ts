import "@supabase/functions-js/edge-runtime.d.ts";
import {
  type CallOutcome,
  logCallStep,
  notifyOrderStatusUpdate,
} from "../_shared/orders.ts";
import { logEvent } from "../_shared/logging.ts";
import { type ConnectContext, resolveConnectConfig } from "./config.ts";
import { buildConnectResponse } from "./exotel.ts";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  // Exotel must re-fetch every time; a cached body could dial a stale number.
  "Cache-Control": "no-store",
};

// ---------------------------------------------------------------------------
// Connect applet — Dynamic URL endpoint.
//
// Wired to an Exotel Connect applet's "Dynamic URL". Exotel GETs this mid-call
// (typically after the caller presses the "talk to support" key) and expects a
// JSON body telling it whom to dial and how. We resolve the destination + call
// settings from config (env today, DB later — see config.ts) and hand back the
// Exotel-shaped body. Same 5-second budget as the other applets: no chained
// lookups, respond fast, never return a non-200 on the happy path.
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
        console.warn("[connect-support] unparseable body ignored");
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
          fn: "connect-support",
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
      const orderId = firstOf(params, "CustomField", "custom_field");

      const ctx: ConnectContext = { orderId, callSid, callerNumber };
      const config = await resolveConnectConfig(ctx);

      // A Connect response with no numbers is meaningless — Exotel would have
      // nothing to dial. Fail loudly with a non-200 so the misconfiguration is
      // visible in Exotel (which can then run its configured fallback URL)
      // rather than silently bridging the caller to dead air.
      if (config.numbers.length === 0) {
        logEvent({
          fn: "connect-support",
          level: "error",
          event: "no_support_number",
          message: "No support number configured — set SUPPORT_NUMBER",
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
          step: "connect_support",
          status: "SUPPORT_CONNECT_NO_NUMBER",
          appletHint: "connect (dynamic-url)",
        });
        return Response.json(
          { error: "No support number configured" },
          { status: 500, headers: JSON_HEADERS },
        );
      }

      const responseBody = buildConnectResponse(config);

      logCallStep({
        callSid,
        callerNumber,
        orderId,
        step: "connect_support",
        status: "SUPPORT_CONNECT_SERVED",
        appletHint: "connect (dynamic-url)",
      });

      // Record the transfer as this call's outcome. Fire-and-forget through
      // update-order-status (the sole owner of the recipients/call_attempts
      // write), so it never eats into Exotel's 5s budget. Skipped when we have
      // no order id (inbound call with no CustomField) or when the update is
      // disabled.
      if (orderId && config.orderStatus) {
        notifyOrderStatusUpdate({
          orderId,
          callSid,
          callerNumber,
          outcome: config.orderStatus as CallOutcome,
        });
      }

      logEvent({
        fn: "connect-support",
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
        fn: "connect-support",
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
