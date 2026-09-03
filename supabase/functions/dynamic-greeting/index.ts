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
// Exotel applet response contracts — there are TWO, and they are not
// interchangeable. Serving one to an applet expecting the other makes Exotel
// abandon the applet and drop the caller, exactly as a 404 or a timeout would.
//
// GREETING applet (the opening and both closings — three of the four nodes):
//   Content-Type: text/plain, body is the text to speak.
//   JSON `{"greeting_url": "<audio url>"}` is the documented alternative.
//   -> greet()
//
// GATHER applet (the menu — the one node that collects a keypress):
//   Content-Type: application/json, documented schema:
//     gather_prompt          object   REQUIRED  { text } or { audio_url }
//     max_input_digits       int      optional  default 255
//     finish_on_key          string   optional  default "#"; "" means no finish key
//     input_timeout          int      optional  default 5 (seconds between keys)
//     repeat_menu            int      optional  default 0
//     repeat_gather_prompt   object   optional  defaults to gather_prompt
//   -> gather(), or speak() for the play-only fallback case
//
// Both must be HTTP 200, within 5 seconds. Every response below therefore goes
// through gather(), greet(), speak() or fallbackSay(); no code path may return
// a bare error to Exotel. The two paths that answer without knowing which node
// asked — the unknown-step branch and the exception handler — pick their shape
// via fallbackSay()/GATHER_STEPS rather than assuming.
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
 * Play-only *Gather* payload: a message with nothing useful to collect.
 *
 * Only the fallback paths use this now — the unknown-step branch and the
 * top-level exception handler, either of which can land on the menu node,
 * which is a Gather applet and would reject plain text. Everything the caller
 * merely listens to is a Greeting applet and goes through greet() instead.
 *
 * Gather has no documented play-only mode, so a digit is nominally collected
 * and discarded; the short timeout keeps the trailing dead air down. That dead
 * air is exactly why the closings no longer come through here.
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

/**
 * Spoken message for a *Greeting* applet: the opening and both closings.
 *
 * Exotel's Greeting applet fetches its dynamic URL expecting either
 * `text/plain` (spoken via TTS, what this returns) or JSON
 * `{"greeting_url": "<audio url>"}`. Hand it the Gather body and it is
 * rejected and the caller dropped — and the reverse is just as fatal, which is
 * what GATHER_STEPS below exists to get right on the fallback paths.
 *
 * A closing belongs here rather than on a Gather applet because there is
 * nothing left to collect: the Switch Case has already routed on the keypress,
 * so the node only has to say its piece and hand over to Hangup. The endpoint
 * is still fetched, so the status write and the step log fire exactly as they
 * did when these were Gather nodes.
 */
function greet(text: string) {
  return new Response(clean(text), {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * The two menu digits, as the closings record them.
 *
 * Exotel routes the collected digit through its own Switch Case and does not
 * echo it into the branch it picks, so the closing step cannot read what was
 * pressed — but it does not need to: each closing is reachable from exactly
 * one branch, so the branch *is* the digit. See the `done` / `issue` cases.
 */
const CONFIRM_DIGIT = "1";
const ISSUE_DIGIT = "2";

/**
 * The only steps wired to a **Gather** applet — the one menu, plus its
 * aliases. Every other step is a **Greeting** applet: the opening, both
 * closings, and anything unrecognised, none of which collect a keypress.
 *
 * This exists for the two paths that have to answer without knowing which node
 * asked — the unknown-step branch and the exception handler. Answering with
 * the wrong shape is fatal either way (a Gather applet rejects plain text as
 * flatly as a Greeting applet rejects the Gather JSON), so those paths pick
 * from here rather than assuming.
 */
const GATHER_STEPS = new Set(["welcome", "menu", "address"]);

/**
 * Say `text` in whichever shape the node that called us can accept.
 *
 * An unrecognised step resolves to Greeting, which is the better bet on two
 * counts: three of the flow's four nodes are Greeting applets, and the far
 * likelier cause of an unknown step — a mistyped closing URL — is a Greeting
 * node being asked to say goodbye, which is exactly what it then does.
 */
function fallbackSay(step: string, text: string) {
  return GATHER_STEPS.has(step) ? speak(text) : greet(text);
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
    const contentType = req.headers.get("content-type") ?? "";
    try {
      if (contentType.includes("multipart/form-data")) {
        // Exotel can deliver applet callbacks as multipart, not
        // form-urlencoded — req.text() + URLSearchParams can't parse that
        // (it silently produces one garbage key from the raw boundary text,
        // dropping CallSid/Digits entirely), so this needs the dedicated
        // parser.
        const form = await req.formData();
        for (const [k, v] of form.entries()) {
          if (!params.has(k) && typeof v === "string") params.append(k, v);
        }
      } else {
        const raw = await req.text();
        if (raw) {
          if (contentType.includes("application/json")) {
            for (const [k, v] of Object.entries(JSON.parse(raw))) {
              if (!params.has(k)) params.append(k, String(v));
            }
          } else {
            for (const [k, v] of new URLSearchParams(raw)) {
              if (!params.has(k)) params.append(k, v);
            }
          }
        }
      }
    } catch (_e) {
      console.warn("[readParams] unparseable body ignored");
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
// Prompts come in pairs — one per script — because the same three Exotel flow
// nodes serve both (see _shared/flow.ts). Each pair keeps the same digit
// meanings (1 = all good, 2 = something is wrong) so a caller who has taken
// both calls hears a consistent menu, and so the Switch Case wiring in Exotel
// stays valid for either script without being touched.
//
// The call is deliberately short: one greeting, one question, one closing.
// An IVR that asks the same person two questions in a row loses callers
// between menus, and the second menu never carried information the first one
// did not — a press-2 on either produced the identical `issue_raised`
// outcome. Merging them costs nothing and takes roughly 20 seconds off every
// call.
// ---------------------------------------------------------------------------

/** How the caller is addressed, in either script. */
function salutation(order: OrderRecord | null): string {
  return order?.customer_name ? `Hello ${order.customer_name}.` : "Hello.";
}

/**
 * Greeting node — plays once, collects nothing, then falls through to the
 * menu. Kept to a single sentence of who is calling and why: callers decide
 * whether to stay on the line in the first few seconds, and anything they
 * need in order to answer the question belongs in the menu itself, where it
 * is repeated if they do not respond.
 */
function orderGreeting(order: OrderRecord | null): string {
  if (!order) {
    return `${salutation(order)} This is an automated call from mjunction
      regarding your recent order.`;
  }

  const item = order.product_name ? ` for ${order.product_name}` : "";

  return `${salutation(order)} This is an automated call from mjunction
    regarding your order ${spellReference(order.order_id)}${item}.`;
}

function deliveryGreeting(order: OrderRecord | null): string {
  if (!order) {
    return `${salutation(order)} This is an automated call from mjunction
      regarding the delivery of your recent order.`;
  }

  const item = order.product_name ? ` for ${order.product_name}` : "";

  return `${salutation(order)} This is an automated call from mjunction
    regarding the delivery of your order ${spellReference(order.order_id)}${item}.`;
}

/**
 * The one and only menu in the order-confirmation script.
 *
 * It reads the address back and asks for a single keypress, because the
 * address is the only thing this call exists to settle — the separate
 * "confirm the order, then confirm the address" pair it replaces asked the
 * caller to press 1 twice to say one thing.
 */
function orderMenuPrompt(order: OrderRecord | null): string {
  if (!order?.delivery_address) {
    return `To confirm your delivery address, press 1.

      If you would like to change your delivery address, press 2.`;
  }

  return `We have your delivery address as ${order.delivery_address}.

    If this address is correct, press 1.

    If you would like to change it, press 2.`;
}

/** The order menu's re-prompt, played when no key is pressed in time. */
function orderMenuRepeat(): string {
  return `Sorry, we did not get your response.

    To confirm your delivery address, press 1.

    To change your delivery address, press 2.`;
}

/**
 * The one and only menu in the delivery-confirmation script, on the same
 * Exotel node as the order menu. "1 = all good" / "2 = something is wrong"
 * keeps its meaning, so the Switch Case routes either script identically.
 */
function deliveryMenuPrompt(order: OrderRecord | null): string {
  const item = order?.product_name ? ` of ${order.product_name}` : "";

  return `If you have received your delivery${item} and it is in good
    condition, press 1.

    If you have not received it, or there is a problem with it, press 2.`;
}

function deliveryMenuRepeat(): string {
  return `Sorry, we did not get your response.

    If you have received your delivery, press 1.

    If you have not received it, or there is a problem with it, press 2.`;
}

function orderConfirmedPrompt(): string {
  return `Thank you for confirming.

    Your delivery address is confirmed and your order will be processed as
    scheduled.

    Thank you for choosing mjunction. Goodbye.`;
}

/**
 * Closing for a press-2 on the order menu.
 *
 * It tells the caller exactly what happens next and in what order, because
 * "someone will get back to you" is the line every caller has been given
 * before and none of them can act on. The WhatsApp link is named first
 * because it is the path that lets them fix the address themselves; the
 * callback is the stated fallback rather than an unexplained second promise.
 *
 * NOTE: nothing in either repo sends that WhatsApp message yet — see the
 * README's "Outstanding: the WhatsApp hand-off" section. Until it does, the
 * `issue_raised` recipient this produces is picked up from mjunction's
 * escalations queue by an agent, which is the callback half of what the
 * caller was just promised.
 */
function orderIssuePrompt(): string {
  return `Thank you for letting us know. Your request has been recorded.

    You will shortly receive a message on WhatsApp with a link to update your
    delivery address.

    If we are unable to reach you on WhatsApp, our support team will call you.

    Thank you for choosing mjunction. Goodbye.`;
}

function deliveryConfirmedPrompt(): string {
  return `Thank you for confirming.

    Your delivery has been confirmed and this order is now complete.

    Thank you for choosing mjunction. Goodbye.`;
}

/**
 * Closing for a press-2 on the delivery menu. A missing or damaged delivery
 * is not something a self-service link can fix, so this one promises the
 * callback outright rather than the WhatsApp path.
 */
function deliveryIssuePrompt(): string {
  return `Thank you for letting us know. Your issue has been recorded.

    Our support team will call you shortly to resolve it.

    Thank you for choosing mjunction. Goodbye.`;
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
              "Point the applet at /dynamic-greeting/greeting (the entry Greeting " +
              "applet) or /dynamic-greeting/welcome (the menu Gather) — path-based, " +
              "which survives Exotel rewriting the query string; ?step= still works. " +
              "Also valid: /passthru, /done, /confirm, /goodbye, /issue, /escalate.",
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
      // The three call nodes, in the order a caller meets them: greeting,
      // menu, closing. Every branch answers 200 — JSON for the Gather
      // applets, text/plain for the Greeting one.
      // ------------------------------------------------------------------
      switch (step) {
        // ------------------------------------------------------------------
        // Node 1 of 3 — Greeting. Plays who is calling and why, collects
        // nothing, then falls straight through to the menu. This is a
        // *Greeting* applet, not a Gather, so it answers text/plain rather
        // than the Gather JSON contract — see greet().
        // ------------------------------------------------------------------
        case "greeting":
        case "greet":
        case "intro": {
          logCallStep({
            callSid,
            callerNumber,
            orderId,
            step: "greeting",
            status: order ? "GREETING_SERVED" : "GREETING_SERVED_NO_ORDER",
            appletHint: "greeting",
          });

          const response = greet(
            isDelivery ? deliveryGreeting(order) : orderGreeting(order),
          );

          logEvent({
            fn: "dynamic-greeting",
            level: orderDegraded ? "warning" : "success",
            event: "greeting_served",
            message: order
              ? `Greeting served for resolved order (${flow})`
              : `Greeting served with NO order resolved (generic wording, ${flow})`,
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

        // ------------------------------------------------------------------
        // Node 2 of 3 — the only menu. One question, one keypress, done.
        //
        // `address` is accepted as an alias purely for the migration window:
        // an Exotel flow still wired the old way routes a welcome-menu "1"
        // here, and serving the same menu again is strictly better than a
        // 400 that drops the caller — they hear the question twice, press
        // once more, and still land on the correct closing. Remove the alias
        // once the flow no longer has that node (see the README section
        // "Migrating from the two-menu flow").
        // ------------------------------------------------------------------
        case "welcome":
        case "menu":
        case "address": {
          logCallStep({
            callSid,
            callerNumber,
            orderId,
            step: "welcome",
            status: order ? "MENU_SERVED" : "MENU_SERVED_NO_ORDER",
            appletHint,
          });

          const response = isDelivery
            ? gather(deliveryMenuPrompt(order), deliveryMenuRepeat())
            : gather(orderMenuPrompt(order), orderMenuRepeat());

          logEvent({
            fn: "dynamic-greeting",
            level: orderDegraded ? "warning" : "success",
            event: "menu_served",
            message: order
              ? `Menu served for resolved order (${flow})`
              : `Menu served with NO order resolved (generic wording, ${flow})`,
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

        // ------------------------------------------------------------------
        // Node 3 of 3 — the two closings, both **Greeting** applets. Each is
        // reached from exactly one
        // Switch Case branch of the menu above, so *which URL Exotel called
        // is itself the keypress*: `done` can only be a "1" and `issue` can
        // only be a "2". That is why both the outcome and the DTMF digit are
        // sent explicitly below rather than read off the request — Exotel
        // does not echo the collected digit into the branch it routes to
        // (confirmed against a live payload; no digit param of any kind is
        // present), so `readDigits` is empty here and is used only as an
        // override for the rare provider/config that does send one.
        //
        // Recording the digit matters: before this, every real IVR call
        // finalized with `dtmf_response = null`, so the admin panel had a
        // DTMF column that was permanently empty for anything but a mock
        // call.
        // ------------------------------------------------------------------
        case "done":
        case "goodbye":
        case "confirm": {
          const pressed = digits || CONFIRM_DIGIT;

          logCallStep({
            callSid,
            callerNumber,
            orderId,
            step: "done",
            userInput: pressed,
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
              dtmf: pressed,
            });
          }

          const response = greet(
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

        // The menu's "press 2", in either script. `escalate` /
        // `address-issue` stay as aliases so a flow wired to a separately
        // named node keeps working without redeploying this function in
        // lockstep.
        case "issue":
        case "escalate":
        case "address-issue": {
          const pressed = digits || ISSUE_DIGIT;

          logCallStep({
            callSid,
            callerNumber,
            orderId,
            step: "done",
            userInput: pressed,
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
              dtmf: pressed,
            });
          }

          const response = greet(
            isDelivery ? deliveryIssuePrompt() : orderIssuePrompt(),
          );

          logEvent({
            fn: "dynamic-greeting",
            level: orderDegraded || !orderId ? "warning" : "success",
            event: "closing_served",
            message: isDelivery
              ? "Escalation message served (delivery issue)"
              : "Escalation message served (address change requested)",
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
          // Unknown step still answers 200 so the call ends cleanly instead of
          // being cut off by Exotel — in whichever body shape the node that
          // called us can read. See fallbackSay().
          logCallStep({
            callSid,
            callerNumber,
            orderId,
            step,
            userInput: digits,
            status: "UNKNOWN_STEP",
            appletHint,
          });

          const response = fallbackSay(
            step,
            "Thank you for calling mjunction. Goodbye.",
          );

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

      // Exotel must still get a body the calling applet accepts, which now
      // depends on which node it was — the step is re-read from the path here
      // because the throw may have happened before it was resolved. Anything
      // else surfaces a real error so genuine bugs stay visible to non-IVR
      // callers.
      if (isIvrPath) {
        return fallbackSay(
          stepFromPath(url.pathname),
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