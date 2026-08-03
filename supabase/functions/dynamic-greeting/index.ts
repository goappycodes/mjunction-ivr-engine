import "@supabase/functions-js/edge-runtime.d.ts";
import {
  getOrderByPhone,
  getOrderById,
  getOrderIdByCallSid,
  logCallStep,
  type OrderRecord,
  withTimeout,
} from "../_shared/orders.ts";
import { firstOf, readDigits, readParams } from "../_shared/params.ts";
import { IVR_STATES } from "../_shared/callState.ts";

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

/**
 * Make an order reference readable by the TTS engine.
 *
 * "ORDER110121" is otherwise spoken as a single large number
 * ("order one hundred ten thousand one hundred twenty one"), which no caller can
 * write down. Separating the digits makes the engine read them individually.
 */
function spellReference(ref: string): string {
  return ref
    .replace(/([A-Za-z]+)/g, " $1 ")
    .replace(/(\d)/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
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
    ${spellReference(order.order_id)}${item}. Press 1 to confirm your order.
    Press 2 if you have any issues.`;
}

function addressPrompt(order: OrderRecord | null): string {
  if (!order?.delivery_address) {
    return `Please confirm your delivery address. Press 1 if your address is
      correct. Press 2 if there are any issues.`;
  }

  // The order reference is spoken once, in the welcome prompt. Repeating a
  // digit-by-digit id on every step makes the call tedious to sit through.
  return `Your order will be delivered to ${order.delivery_address}.
    Press 1 if this address is correct. Press 2 if there are any issues.`;
}

function closingPrompt(_order: OrderRecord | null, issue: boolean): string {
  return issue
    ? `Thank you. We have noted your issue and our team will contact you
       shortly. Goodbye.`
    : `Thank you for confirming. Your order will be delivered as scheduled.
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
      const stepParam = (params.get("step") || "").trim().toLowerCase();

      // A missing `step` used to mean "Passthru" and returned an empty body.
      // That silently produced blank calls: if the bare URL is wired to a
      // Gather applet (easy to do — Exotel appends its own params, so the
      // configured URL looks complete without `?step=`), Exotel received zero
      // bytes where it expected a prompt and the caller heard nothing.
      //
      // Defaulting to the welcome prompt is safe for both applet types: a
      // Gather applet gets the JSON it needs, and Passthru evaluates only the
      // HTTP status code (200 here) and ignores the body. Pure call-start
      // logging with no body is still available via an explicit ?step=passthru.
      const step = stepParam || "welcome";

      // A request with no `step` is almost always a Passthru applet. Passthru
      // cannot play audio or text to the caller at all — it only passes data and
      // reads back a status code — so a flow that relies on it for prompts
      // produces a connected but completely silent call. We still answer with a
      // valid Gather body (harmless to Passthru, correct for Gather), but the
      // fact is recorded so a silent call is diagnosable from the logs instead
      // of looking like a successful prompt.
      const appletHint = stepParam
        ? "gather"
        : `no-step (likely passthru; CallType=${
          firstOf(params, "CallType") || "?"
        })`;

      const { order, orderId, source } = await resolveOrder(params);

      console.log(
        `[dynamic-greeting] step=${step}${stepParam ? "" : " (DEFAULTED)"} ` +
          `callSid=${callSid || "-"} from=${callerNumber || "-"} ` +
          `order=${orderId || "-"} via=${source} digits=${digits || "-"}`,
      );

      if (!stepParam) {
        console.warn(
          "[dynamic-greeting] request arrived WITHOUT a step parameter. If this " +
            "is a Passthru applet it cannot speak, and the caller will hear " +
            "silence. Point a Gather applet at ?step=welcome instead.",
        );
      }

      // ------------------------------------------------------------------
      // Explicit Passthru — data-only notification, no audio. Exotel reads
      // just the status code here, so the body is deliberately empty.
      // ------------------------------------------------------------------
      if (step === "passthru") {
        logCallStep({
          callSid,
          callerNumber,
          orderId,
          step: "passthru",
          status: IVR_STATES.CALL_STARTED,
          appletHint: "passthru (explicit)",
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
            // "SERVED" not "PLAYED": we returned a prompt, but whether the
            // caller actually heard it depends on the applet type, which only
            // Exotel knows. Claiming PLAYED made silent calls look successful.
            status: stepParam
              ? (order
                ? IVR_STATES.WELCOME_SERVED
                : IVR_STATES.WELCOME_SERVED_NO_ORDER)
              : IVR_STATES.WELCOME_SERVED_NO_STEP,
            appletHint,
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
              ? IVR_STATES.ORDER_ISSUE_RAISED
              : digits === "1"
              ? IVR_STATES.ORDER_CONFIRMED
              : IVR_STATES.ADDRESS_PROMPT_SERVED,
            appletHint,
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
            status: issue
              ? IVR_STATES.ADDRESS_ISSUE_RAISED
              : IVR_STATES.ADDRESS_CONFIRMED,
            appletHint,
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
            status: IVR_STATES.UNKNOWN_STEP,
            appletHint,
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
