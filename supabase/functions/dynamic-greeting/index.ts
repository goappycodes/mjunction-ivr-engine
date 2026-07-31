import "@supabase/functions-js/edge-runtime.d.ts";
import {
  getOrderByPhone,
  getOrderById,
  getOrderIdByCallSid,
  logCallStep,
  type OrderRecord,
  withTimeout,
} from "../_shared/orders.ts";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

// ---------------------------------------------------------------------------
// Exotel Gather applet response contract
//
// Documented schema:
//   gather_prompt          object   REQUIRED  { text } or { audio_url }
//   max_input_digits       int      optional  default 255
//   finish_on_key          string   optional  default "#"; "" means no finish key
//   input_timeout          int      optional  default 5 (seconds between keys)
//   repeat_menu            int      optional  default 0
//   repeat_gather_prompt   object   optional  defaults to gather_prompt
//
// Must be HTTP 200 with Content-Type: application/json. Anything else — a 404, a
// non-JSON body, or no reply within 5 seconds — makes Exotel abandon the applet
// and drop the caller. Every response below therefore goes through gather() or
// speak(); no code path may return a bare error to Exotel.
// ---------------------------------------------------------------------------

function gather(text: string, repeatText?: string) {
  const body: Record<string, unknown> = {
    gather_prompt: { text: clean(text) },
    // Both of these are sent explicitly because Exotel's defaults (255 digits
    // and "#") are wrong for a single-digit menu. An empty finish_on_key is
    // valid and documented as "no finish key".
    max_input_digits: 1,
    finish_on_key: "",
    input_timeout: 5,
  };

  if (repeatText) {
    body.repeat_menu = 1;
    body.repeat_gather_prompt = { text: clean(repeatText) };
  }

  return Response.json(body, { status: 200, headers: JSON_HEADERS });
}

/**
 * Closing message. Still a Gather payload, because these steps are wired to
 * Gather applets — a Greeting applet expects a different body entirely
 * (`{"greeting_url": ...}` or text/plain). Gather has no documented play-only
 * mode, so a digit is nominally collected and discarded; the short timeout keeps
 * the trailing dead air down.
 */
function speak(text: string) {
  return Response.json({
    gather_prompt: { text: clean(text) },
    max_input_digits: 1,
    finish_on_key: "",
    input_timeout: 2,
  }, { status: 200, headers: JSON_HEADERS });
}

/** Collapse whitespace so the TTS engine gets a clean single-line prompt. */
function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

/**
 * Exotel sends applet parameters as a query string on GET. POST bodies are also
 * accepted so the endpoint stays testable and tolerant of Passthru
 * configuration, but query params always win.
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
        console.warn("[readParams] unparseable body ignored");
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

/**
 * Exotel documents that `digits` arrives wrapped in double quotes and must be
 * trimmed, e.g. `"1"`.
 */
function readDigits(params: URLSearchParams): string {
  return firstOf(params, "digits", "Digits", "dtmf", "DTMF")
    .replace(/["\s]/g, "");
}

// ---------------------------------------------------------------------------
// Order resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the order this call is about, in order of reliability:
 *
 *   1. `CustomField` — the order id ivr-engine passed to Calls/connect. Exotel
 *      echoes it to every applet, so this is the normal path.
 *   2. `CallSid` — ivr-engine also stored the mapping when it placed the call,
 *      which covers any applet request that arrives without CustomField.
 *   3. Caller number — the only option for an inbound call, which never has a
 *      CustomField.
 *
 * The whole chain is capped at DB_TIMEOUT_MS so a slow database degrades to a
 * generic prompt instead of a dropped call.
 */
async function resolveOrder(
  params: URLSearchParams,
): Promise<{ order: OrderRecord | null; orderId: string; source: string }> {
  const customField = firstOf(params, "CustomField", "custom_field");
  const callSid = firstOf(params, "CallSid", "call_sid");
  const from = firstOf(params, "CallFrom", "From", "caller_number");

  const resolved = await withTimeout(
    (async () => {
      if (customField) {
        const order = await getOrderById(customField);
        if (order) return { order, orderId: order.order_id, source: "CustomField" };
        console.warn(`[resolveOrder] CustomField "${customField}" matched no order`);
      }

      if (callSid) {
        const mapped = await getOrderIdByCallSid(callSid);
        if (mapped) {
          const order = await getOrderById(mapped);
          if (order) return { order, orderId: order.order_id, source: "CallSid" };
        }
      }

      if (from) {
        const order = await getOrderByPhone(from);
        if (order) return { order, orderId: order.order_id, source: "CallFrom" };
      }

      return { order: null, orderId: customField, source: "unresolved" };
    })(),
    { order: null, orderId: customField, source: "timeout" },
    "resolveOrder",
  );

  return resolved;
}

// ---------------------------------------------------------------------------
// Prompt construction — every prompt is built from the resolved order
// ---------------------------------------------------------------------------

function welcomePrompt(order: OrderRecord | null): string {
  if (!order) {
    return `Welcome to mjunction. We are calling regarding your recent order.
      Press 1 to confirm your order. Press 2 if you have any issues.`;
  }

  const greeting = order.customer_name ? `Hello ${order.customer_name}.` : "Hello.";
  const item = order.product_name ? ` for ${order.product_name}` : "";

  return `${greeting} This is a call from mjunction regarding your order
    ${order.order_id}${item}. Press 1 to confirm your order. Press 2 if you
    have any issues.`;
}

function addressPrompt(order: OrderRecord | null): string {
  if (!order?.delivery_address) {
    return `Please confirm your delivery address. Press 1 if your address is
      correct. Press 2 if there are any issues.`;
  }

  return `Your order ${order.order_id} will be delivered to
    ${order.delivery_address}. Press 1 if this address is correct. Press 2 if
    there are any issues.`;
}

function closingPrompt(order: OrderRecord | null, issue: boolean): string {
  const subject = order ? `Your order ${order.order_id}` : "Your order";

  return issue
    ? `Thank you. We have noted your issue with ${
      order ? `order ${order.order_id}` : "your order"
    } and our team will contact you shortly. Goodbye.`
    : `Thank you for confirming. ${subject} will be delivered as scheduled.
       Goodbye.`;
}

// ---------------------------------------------------------------------------

export default {
  fetch: async (req: Request) => {
    const url = new URL(req.url);
    const isIvrPath = url.pathname.includes("/dynamic-greeting");

    try {
      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          },
        });
      }

      if (!isIvrPath) {
        return new Response("Not Found", { status: 404 });
      }

      const params = await readParams(req, url);
      const callSid = firstOf(params, "CallSid", "call_sid");
      const callerNumber = firstOf(params, "CallFrom", "From", "caller_number");
      const digits = readDigits(params);
      const hasStep = params.has("step");
      const step = (params.get("step") || "welcome").trim().toLowerCase();

      const { order, orderId, source } = await resolveOrder(params);

      console.log(
        `[dynamic-greeting] step=${hasStep ? step : "passthru"} ` +
          `callSid=${callSid || "-"} from=${callerNumber || "-"} ` +
          `order=${orderId || "-"} via=${source} digits=${digits || "-"}`,
      );

      // ------------------------------------------------------------------
      // Passthru — call-start notification. Exotel expects 200, empty body.
      // ------------------------------------------------------------------
      if (!hasStep) {
        logCallStep({
          callSid,
          callerNumber,
          orderId,
          step: "passthru",
          status: "CALL_STARTED",
        });

        return new Response(null, {
          status: 200,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      // ------------------------------------------------------------------
      // Gather applets — always 200 + JSON.
      // ------------------------------------------------------------------
      switch (step) {
        case "welcome":
          logCallStep({
            callSid,
            callerNumber,
            orderId,
            step: "welcome",
            status: order ? "WELCOME_PLAYED" : "WELCOME_PLAYED_NO_ORDER",
          });

          return gather(
            welcomePrompt(order),
            `Sorry, I didn't receive your input. Press 1 to confirm your order
             or press 2 if you have any issues.`,
          );

        case "address":
          // The digit pressed on the welcome menu arrives with this request.
          logCallStep({
            callSid,
            callerNumber,
            orderId,
            step: "address",
            userInput: digits,
            status: digits === "2"
              ? "ORDER_ISSUE_RAISED"
              : digits === "1"
              ? "ORDER_CONFIRMED"
              : "ADDRESS_PROMPT_PLAYED",
          });

          return gather(
            addressPrompt(order),
            `Sorry, I didn't receive your input. Press 1 if your address is
             correct or press 2 if there are any issues.`,
          );

        case "done":
        case "goodbye":
        case "confirm":
        case "issue": {
          const issue = digits === "2" || step === "issue";

          logCallStep({
            callSid,
            callerNumber,
            orderId,
            step: "done",
            userInput: digits,
            status: issue ? "ADDRESS_ISSUE_RAISED" : "ADDRESS_CONFIRMED",
          });

          return speak(closingPrompt(order, issue));
        }

        default:
          // Unknown step still answers 200 + JSON so the call ends cleanly
          // instead of being cut off by Exotel.
          console.warn(`[dynamic-greeting] unknown step "${step}"`);
          logCallStep({
            callSid,
            callerNumber,
            orderId,
            step,
            userInput: digits,
            status: "UNKNOWN_STEP",
          });

          return speak("Thank you for calling mjunction. Goodbye.");
      }
    } catch (err) {
      console.error("Error in dynamic-greeting:", err);

      // Exotel must still get a valid Gather body; anything else surfaces a real
      // error so genuine bugs stay visible to non-IVR callers.
      if (isIvrPath) {
        return speak(
          "Sorry, we are unable to process your call right now. Goodbye.",
        );
      }
      return Response.json({ error: "Internal Server Error" }, { status: 500 });
    }
  },
};
