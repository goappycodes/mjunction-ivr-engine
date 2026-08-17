import "@supabase/functions-js/edge-runtime.d.ts";
import {
  getOrderByPhone,
  getOrderById,
  getOrderIdByCallSid,
  logCallStep,
  notifyOrderStatusUpdate,
  type OrderRecord,
  withTimeout,
} from "../_shared/orders.ts";
import { logEvent } from "../_shared/logging.ts";
import {
  type CallFlow,
  inferFlowFromStatus,
  parseCustomField,
} from "../_shared/flow.ts";

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
    // Known-good value. Exotel examples use <=6; a larger value (10) is outside
    // the range Exotel reliably accepts and made it reject the Gather response,
    // dropping the call. Keep this conservative.
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
  return Response.json(
    {
      gather_prompt: { text: clean(text) },
      max_input_digits: 1,
      finish_on_key: "",
      input_timeout: 2,
    },
    { status: 200, headers: JSON_HEADERS },
  );
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
 * Read `step` from the URL PATH instead of the query string, e.g.
 * `/dynamic-greeting/welcome` -> "welcome".
 *
 * Exotel's Dynamic URL fetch appends its own params (CallSid, CallFrom,
 * CustomField, digits, ...) to whatever URL is configured in the applet. In
 * practice this has been observed to REWRITE the query string rather than
 * append to it — a configured `?step=address` arrives at this function with
 * only Exotel's own params and no `step` at all, which is indistinguishable
 * from a genuinely misconfigured applet. The path portion of the URL is not
 * involved in that rewriting, so encoding the step there is immune to it.
 * `?step=` is still read as a fallback (see stepParam below) for local
 * testing and any applet still configured the old way.
 */
function stepFromPath(pathname: string): string {
  const marker = "/dynamic-greeting";
  const idx = pathname.indexOf(marker);
  if (idx === -1) return "";
  return pathname
    .slice(idx + marker.length)
    .replace(/^\/+|\/+$/g, "")
    .trim()
    .toLowerCase();
}

/**
 * Exotel documents that `digits` arrives wrapped in double quotes and must be
 * trimmed, e.g. `"1"`.
 */
function readDigits(params: URLSearchParams): string {
  return firstOf(params, "digits", "Digits", "dtmf", "DTMF").replace(
    /["\s]/g,
    "",
  );
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
): Promise<{
  order: OrderRecord | null;
  orderId: string;
  source: string;
  flow: CallFlow;
}> {
  const rawCustomField = firstOf(params, "CustomField", "custom_field");
  const callSid = firstOf(params, "CallSid", "call_sid");
  const from = firstOf(params, "CallFrom", "From", "caller_number");

  // The flow suffix ivr-engine encoded into CustomField is the authoritative
  // signal for which script to read, and it costs nothing to recover. When
  // it's absent — an inbound call, or a provider that mangled the field — the
  // recipient's own status is the fallback, resolved below once the order is
  // known. See _shared/flow.ts.
  const { orderId: customField, flow: declaredFlow } = parseCustomField(rawCustomField);

  const resolved = await withTimeout(
    (async () => {
      if (customField) {
        const order = await getOrderById(customField);
        if (order)
          return { order, orderId: order.order_id, source: "CustomField" };
        console.warn(
          `[resolveOrder] CustomField "${customField}" matched no order`,
        );
      }

      if (callSid) {
        const mapped = await getOrderIdByCallSid(callSid);
        if (mapped) {
          const order = await getOrderById(mapped);
          if (order)
            return { order, orderId: order.order_id, source: "CallSid" };
        }
      }

      if (from) {
        const order = await getOrderByPhone(from);
        if (order)
          return { order, orderId: order.order_id, source: "CallFrom" };
      }

      return { order: null, orderId: customField, source: "unresolved" };
    })(),
    { order: null, orderId: customField, source: "timeout" },
    "resolveOrder",
  );

  return {
    ...resolved,
    flow: declaredFlow ?? inferFlowFromStatus(resolved.order?.status),
  };
}

// ---------------------------------------------------------------------------
// Prompt construction — every prompt is built from the resolved order
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Prompts come in pairs — one per script — because the same four Exotel flow
// nodes serve both (see _shared/flow.ts). Each pair keeps the same digit
// meanings (1 = all good, 2 = something is wrong) so a caller who has taken
// both calls hears a consistent menu, and so the Switch Case wiring in Exotel
// stays valid for either script without being touched.
// ---------------------------------------------------------------------------

function welcomePrompt(order: OrderRecord | null): string {
  if (!order) {
    return `Welcome to mjunction.

      This is an automated call regarding your recent order.

      To confirm your order, please press 1.

      If you would like to report an issue with this order, please press 2.`;
  }

  const greeting = order.customer_name
    ? `Hello ${order.customer_name}.`
    : "Hello.";
  const item = order.product_name ? ` for ${order.product_name}` : "";

  return `${greeting} Welcome to mjunction.

    This is an automated call regarding your order
    ${spellReference(order.order_id)}${item}.

    To confirm your order, please press 1.

    If you would like to report an issue with this order, please press 2.`;
}

function addressPrompt(order: OrderRecord | null): string {
  if (!order?.delivery_address) {
    return `Please confirm your delivery address.

      If your delivery address is correct, please press 1.

      If there is an issue with your delivery address, please press 2.`;
  }

  // The order reference is spoken once, in the welcome prompt. Repeating a
  // digit-by-digit id on every step makes the call tedious to sit through.
  return `Our records show your delivery address as

    ${order.delivery_address}.

    If this address is correct, please press 1.

    If there is an issue with this address, please press 2.`;
}

function orderConfirmedPrompt(): string {
  return `Thank you for confirming your order.

    Your order has been successfully confirmed and will be processed according to the delivery schedule.

    Thank you for choosing mjunction.

    Goodbye.`;
}

/**
 * The one closing for every "press 2", in both scripts.
 *
 * Deliberately identical wording whichever menu the caller pressed 2 on and
 * whichever script they are in: at this point the only thing true of all four
 * cases is that a person will follow up. Anything more specific would be a
 * promise this function cannot keep — it does not know what the caller's
 * problem is, only that they have one.
 */
function escalationPrompt(): string {
  return `For your assistance, we're connecting you with our team now.

    One of our team members will call you shortly.`;
}

// --- delivery-confirmation script -----------------------------------------

/**
 * Delivery welcome menu, on the same node as the order-confirmation welcome.
 * "Press 1 = received" / "press 2 = not received" — the digits keep their
 * "all good" / "something is wrong" meanings, so Exotel's Switch Case routes
 * a non-delivery to the same `issue` closing branch the order script uses.
 */
function deliveryWelcomePrompt(order: OrderRecord | null): string {
  if (!order) {
    return `Welcome to mjunction.

      This is an automated call regarding the delivery of your recent order.

      If you have received your delivery, please press 1.

      If you have not received it yet, please press 2.`;
  }

  const greeting = order.customer_name
    ? `Hello ${order.customer_name}.`
    : "Hello.";
  const item = order.product_name ? ` for ${order.product_name}` : "";

  return `${greeting} Welcome to mjunction.

    This is an automated call regarding the delivery of your order
    ${spellReference(order.order_id)}${item}.

    If you have received your delivery, please press 1.

    If you have not received it yet, please press 2.`;
}

/**
 * Second-level menu, on the node the address prompt uses in the other script.
 * Having confirmed the parcel arrived, the caller now confirms the item
 * itself is right — and "press 2" raises an issue for an agent to pick up,
 * exactly as an address problem does on the order script.
 */
function deliveryItemPrompt(order: OrderRecord | null): string {
  if (!order?.product_name) {
    return `Thank you.

      If the item you received is correct and in good condition, please press 1.

      If there is any problem with the item, please press 2 to report it.`;
  }

  return `Thank you.

    Please confirm the item you received: ${order.product_name}.

    If it is correct and in good condition, please press 1.

    If there is any problem with the item, please press 2 to report it.`;
}

function deliveryConfirmedPrompt(): string {
  return `Thank you for confirming your delivery.

    Your delivery has been successfully confirmed and this order is now complete.

    Thank you for choosing mjunction.

    Goodbye.`;
}

// ---------------------------------------------------------------------------

export default {
  fetch: async (req: Request) => {
    const startedAt = Date.now();
    const url = new URL(req.url);
    const isIvrPath = url.pathname.includes("/dynamic-greeting");

    try {
      if (req.method === "OPTIONS") {
        logEvent({
          fn: "dynamic-greeting",
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

      if (!isIvrPath) {
        logEvent({
          fn: "dynamic-greeting",
          level: "warning",
          event: "path_not_found",
          message: `Request to unrelated path ${url.pathname}`,
          method: req.method,
          url: req.url,
          status: 404,
          durationMs: Date.now() - startedAt,
        });
        return new Response("Not Found", { status: 404 });
      }

      const params = await readParams(req, url);
      const allParams = Object.fromEntries(params.entries());
      const callSid = firstOf(params, "CallSid", "call_sid");
      const callerNumber = firstOf(params, "CallFrom", "From", "caller_number");
      const digits = readDigits(params);
      // Path wins over query param — see stepFromPath() for why.
      const stepParam = stepFromPath(url.pathname) ||
        (params.get("step") || "").trim().toLowerCase();

      // `step` is mandatory — no more defaulting to "welcome". The entry
      // applet in Exotel MUST be configured to reach this function with a
      // step, preferably via the URL path (e.g. /dynamic-greeting/welcome —
      // see stepFromPath()), which survives Exotel rewriting the query
      // string. This trades the old silent-fallback safety net for loud, fast
      // failure: a misconfigured applet (no resolvable step) is now a
      // diagnosable 400 with the full incoming request captured in the logs,
      // instead of quietly limping along on a guessed default.
      //
      // Trade-off to be aware of: if a *Gather* applet is ever wired to this
      // URL without a resolvable step, Exotel gets a non-Gather-shaped 400
      // instead of a valid prompt, which Exotel treats as an invalid response
      // and drops the call — exactly the failure this endpoint used to paper
      // over. Only acceptable because every applet is now required to
      // resolve a step (welcome for the entry point, passthru for pure
      // call-start logging), so a real call should never hit this path.
      if (!stepParam) {
        logEvent({
          fn: "dynamic-greeting",
          level: "error",
          event: "step_missing",
          message: "No step resolved from path or query",
          method: req.method,
          url: req.url,
          params: allParams,
          status: 400,
          callSid,
          callerNumber,
          durationMs: Date.now() - startedAt,
        });

        logCallStep({
          callSid,
          callerNumber,
          step: "missing_step",
          userInput: JSON.stringify(allParams),
          status: "STEP_PARAM_MISSING",
          appletHint: `no-step (CallType=${firstOf(params, "CallType") || "?"})`,
        });

        return Response.json(
          {
            error: "Missing required step",
            hint:
              "Point the applet at /dynamic-greeting/welcome (preferred, path-based — " +
              "survives Exotel rewriting the query string) or ?step=welcome. " +
              "Also valid: /passthru, /address, /done, /confirm, /issue, /goodbye.",
            received: allParams,
          },
          { status: 400, headers: JSON_HEADERS },
        );
      }

      const step = stepParam;
      const appletHint = "gather";

      const { order, orderId, source, flow } = await resolveOrder(params);
      const isDelivery = flow === "delivery_confirmation";
      // Order resolution failing/timing out is not fatal (the prompt
      // degrades to generic wording), but it is anomalous enough to flag —
      // every log below is "warning" instead of "success" whenever that
      // happened, so it's visible without treating it as a hard error.
      const orderDegraded = !order || source === "timeout" ||
        source === "unresolved";

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
          status: "CALL_STARTED",
          appletHint: "passthru (explicit)",
        });

        logEvent({
          fn: "dynamic-greeting",
          level: orderDegraded ? "warning" : "success",
          event: "passthru_served",
          message: "Passthru call-start logged",
          method: req.method,
          url: req.url,
          params: allParams,
          status: 200,
          callSid,
          callerNumber,
          orderId,
          step,
          durationMs: Date.now() - startedAt,
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
        case "welcome": {
          logCallStep({
            callSid,
            callerNumber,
            orderId,
            step: "welcome",
            // "SERVED" not "PLAYED": we returned a prompt, but whether the
            // caller actually heard it depends on the applet type, which only
            // Exotel knows. Claiming PLAYED made silent calls look successful.
            status: order ? "WELCOME_SERVED" : "WELCOME_SERVED_NO_ORDER",
            appletHint,
          });

          const response = isDelivery
            ? gather(
              deliveryWelcomePrompt(order),
              `We did not receive a valid response.

               If you have received your delivery, please press 1.

               If you have not received it yet, please press 2.`,
            )
            : gather(
              welcomePrompt(order),
              `We did not receive a valid response.

               To confirm your order, please press 1.

               To report an issue with this order, please press 2.`,
            );

          logEvent({
            fn: "dynamic-greeting",
            level: orderDegraded ? "warning" : "success",
            event: "welcome_served",
            message: order
              ? `Welcome prompt served for resolved order (${flow})`
              : `Welcome prompt served with NO order resolved (generic wording, ${flow})`,
            method: req.method,
            url: req.url,
            params: allParams,
            status: 200,
            callSid,
            callerNumber,
            orderId,
            step,
            durationMs: Date.now() - startedAt,
          });

          return response;
        }

        case "address": {
          // Reached only via the welcome Gather's "confirm" branch (Exotel's
          // own Switch Case routes on the collected digit and only calls
          // this URL for a "1" press) — the order-confirmation digit is
          // implied by having reached this step at all, not something to
          // read back from the request. Exotel does not echo a prior digit
          // into this flow's requests (confirmed by inspecting the raw
          // payload — no digit param of any kind is present).
          logCallStep({
            callSid,
            callerNumber,
            orderId,
            step: "address",
            userInput: digits,
            status: isDelivery ? "DELIVERY_ITEM_PROMPT_SERVED" : "ADDRESS_PROMPT_SERVED",
            appletHint,
          });

          const response = isDelivery
            ? gather(
              deliveryItemPrompt(order),
              `We did not receive a valid response.

               If the item you received is correct and in good condition, please press 1.

               If there is any problem with the item, please press 2.`,
            )
            : gather(
              addressPrompt(order),
              `We did not receive a valid response.

               If your delivery address is correct, please press 1.

               If there is an issue with your delivery address, please press 2.`,
            );

          logEvent({
            fn: "dynamic-greeting",
            level: orderDegraded ? "warning" : "success",
            event: "address_served",
            message: isDelivery
              ? "Delivery item prompt served"
              : "Address prompt served",
            method: req.method,
            url: req.url,
            params: allParams,
            status: 200,
            callSid,
            callerNumber,
            orderId,
            step,
            durationMs: Date.now() - startedAt,
          });

          return response;
        }

        // Each of these is reached via a distinct Switch Case branch in the
        // configured Exotel flow, so the outcome is implied entirely by
        // which URL was called — sent explicitly to update-order-status
        // rather than derived from a DTMF digit that this flow never
        // forwards (see the "address" case comment above).
        case "done":
        case "goodbye":
        case "confirm": {
          // Reached only via the second Gather's "correct" branch — the
          // address is right (order script) or the delivered item is right
          // (delivery script).
          logCallStep({
            callSid,
            callerNumber,
            orderId,
            step: "done",
            userInput: digits,
            status: isDelivery ? "DELIVERY_CONFIRMED" : "ADDRESS_CONFIRMED",
            appletHint,
          });

          // Fire-and-forget: hand off to update-order-status so the DB write
          // happens out of band. This must never delay or block the Exotel
          // response below — notifyOrderStatusUpdate does not await the
          // network call, it schedules it via EdgeRuntime.waitUntil.
          if (orderId) {
            notifyOrderStatusUpdate({
              orderId,
              callSid,
              callerNumber,
              outcome: "confirmed",
            });
          }

          const response = speak(
            isDelivery ? deliveryConfirmedPrompt() : orderConfirmedPrompt(),
          );

          logEvent({
            fn: "dynamic-greeting",
            level: orderDegraded || !orderId ? "warning" : "success",
            event: "closing_served",
            message: isDelivery
              ? "Closing message served (delivery confirmed)"
              : "Closing message served (address confirmed)",
            method: req.method,
            url: req.url,
            params: allParams,
            status: 200,
            callSid,
            callerNumber,
            orderId,
            step,
            durationMs: Date.now() - startedAt,
          });

          return response;
        }

        // Every "press 2" in either script ends here — the welcome menu's
        // branch and the second menu's branch alike.
        //
        // The second menu's branch used to go to a Greeting + Connect applet
        // that live-transferred the caller. That transfer is gone: both
        // branches now play the same escalation message and raise an issue for
        // an agent to pick up from the escalations queue. Because both mean
        // the same thing, they share one Exotel node — see the README's flow
        // diagram. `escalate` / `address-issue` are accepted as aliases so a
        // flow wired to a separate node for the second menu also works
        // without needing this function redeployed in lockstep.
        case "issue":
        case "escalate":
        case "address-issue": {
          logCallStep({
            callSid,
            callerNumber,
            orderId,
            step: "done",
            userInput: digits,
            status: isDelivery ? "DELIVERY_ISSUE_RAISED" : "ORDER_ISSUE_RAISED",
            appletHint,
          });

          if (orderId) {
            notifyOrderStatusUpdate({
              orderId,
              callSid,
              callerNumber,
              // One outcome for every press-2, in both scripts: the recipient
              // moves to `issue_raised` and an agent takes it from the
              // escalations queue.
              outcome: "issue_raised",
            });
          }

          const response = speak(escalationPrompt());

          logEvent({
            fn: "dynamic-greeting",
            level: orderDegraded || !orderId ? "warning" : "success",
            event: "closing_served",
            message: isDelivery
              ? "Escalation message served (delivery issue)"
              : "Escalation message served (order issue)",
            method: req.method,
            url: req.url,
            params: allParams,
            status: 200,
            callSid,
            callerNumber,
            orderId,
            step,
            durationMs: Date.now() - startedAt,
          });

          return response;
        }

        default: {
          // Unknown step still answers 200 + JSON so the call ends cleanly
          // instead of being cut off by Exotel.
          logCallStep({
            callSid,
            callerNumber,
            orderId,
            step,
            userInput: digits,
            status: "UNKNOWN_STEP",
            appletHint,
          });

          const response = speak("Thank you for calling mjunction. Goodbye.");

          logEvent({
            fn: "dynamic-greeting",
            level: "warning",
            event: "unknown_step",
            message: `Unrecognised step "${step}" — served generic goodbye`,
            method: req.method,
            url: req.url,
            params: allParams,
            status: 200,
            callSid,
            callerNumber,
            orderId,
            step,
            durationMs: Date.now() - startedAt,
          });

          return response;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent({
        fn: "dynamic-greeting",
        level: "error",
        event: "unhandled_exception",
        message,
        method: req.method,
        url: req.url,
        status: isIvrPath ? 200 : 500,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        durationMs: Date.now() - startedAt,
      });

      // Exotel must still get a valid Gather body; anything else surfaces a real
      // error so genuine bugs stay visible to non-IVR callers.
      if (isIvrPath) {
        return speak(
          `
We apologize.

We are currently unable to process your request.

Please try again later or contact our customer support team for assistance.

Thank you.

Goodbye.
`,
        );
      }
      return Response.json({ error: "Internal Server Error" }, { status: 500 });
    }
  },
};