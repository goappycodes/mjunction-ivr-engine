import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
// Server-to-server webhook: there is no end-user session to act on behalf of,
// so use the service-role key. The anon key would be subject to RLS and every
// read/write here would silently return zero rows.
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_ANON_KEY") ?? "";

// createClient throws if the key is empty. At module scope that would make the
// worker fail to boot and Exotel would see a 500 before any handler ran, so the
// client is created lazily and a missing key degrades to "no logging" instead
// of killing the call.
let cachedClient: ReturnType<typeof createClient> | null = null;
function db() {
  if (!supabaseKey) return null;
  if (!cachedClient) cachedClient = createClient(supabaseUrl, supabaseKey);
  return cachedClient;
}

const FALLBACK_ORDER_ID = "ORD12345";
const FALLBACK_FROM = "08116411177";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

/**
 * Exotel's dynamic Gather applet terminates the call unless it receives
 * HTTP 200 with a well-formed JSON body. Every response on the IVR path must
 * go through here — never a bare 404/500.
 */
function gather(
  text: string,
  opts: { repeatText?: string; maxDigits?: number } = {},
) {
  const body: Record<string, unknown> = {
    gather_prompt: { text },
    max_input_digits: opts.maxDigits ?? 1,
    input_timeout: 5,
  };

  // `finish_on_key` must be an actual DTMF key. The previous empty string was
  // not a valid value, so it is omitted unless there is something to send.
  if (opts.repeatText) {
    body.repeat_menu = 1;
    body.repeat_gather_prompt = { text: opts.repeatText };
  }

  return Response.json(body, { status: 200, headers: JSON_HEADERS });
}

/**
 * Terminal message: plays text and lets the flow move on.
 *
 * Deliberately reuses the same field shape as `gather()` (which Exotel is
 * already known to accept on the welcome/address prompts) rather than sending
 * `max_input_digits: 0`, which is not verified against the Exotel applet spec.
 * The short timeout keeps the trailing dead air minimal.
 */
function speak(text: string) {
  return Response.json(
    { gather_prompt: { text }, max_input_digits: 1, input_timeout: 3 },
    { status: 200, headers: JSON_HEADERS },
  );
}

/**
 * Exotel sends applet parameters as a query string on GET (Passthru and
 * dynamic Gather) but as a form-encoded body on POST. The previous version
 * only read the body, so on Exotel's GET requests CallSid was always absent
 * and got replaced by a synthetic `call_<timestamp>` — which meant the later
 * `.update().eq("call_sid", ...)` never matched the row it had just written.
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
    if (value) return value;
  }
  return "";
}

/** Exotel wraps collected DTMF in quotes on some flows, e.g. `"1"`. */
function readDigits(params: URLSearchParams): string {
  const raw = firstOf(params, "digits", "Digits", "dtmf", "DTMF", "gather_input");
  return raw.replace(/["\s]/g, "");
}

/**
 * Callers arrive as `08116411177`, `8116411177` or `+918116411177` depending on
 * the circuit. Match on the last 10 digits so the order lookup actually hits
 * instead of always falling through to the hardcoded id.
 */
async function lookupOrderId(phone: string): Promise<string> {
  const client = db();
  if (!client) {
    console.warn("[lookupOrderId] no Supabase key configured; using fallback");
    return FALLBACK_ORDER_ID;
  }

  const national = phone.replace(/\D/g, "").slice(-10);

  const { data, error } = await client
    .from("orders")
    .select("order_id")
    // PostgREST uses `*` as the LIKE wildcard in filter strings, not `%`.
    .or(`phone_number.eq.${phone},phone_number.like.*${national}`)
    .limit(1)
    .maybeSingle();

  // Errors are logged but never thrown: a DB problem must not drop the call.
  if (error) {
    console.error("[lookupOrderId] failed:", error.code, error.message);
    return FALLBACK_ORDER_ID;
  }

  if (!data?.order_id) {
    console.warn(`[lookupOrderId] no order for ${phone} (national=${national})`);
    return FALLBACK_ORDER_ID;
  }

  return data.order_id;
}

async function logStep(entry: {
  callSid: string;
  callerNumber?: string;
  orderId?: string;
  step: string;
  userInput?: string;
  status: string;
}) {
  const client = db();
  if (!client || !entry.callSid) return;

  const { error } = await client.from("ivr_logs").upsert({
    call_sid: entry.callSid,
    caller_number: entry.callerNumber,
    order_id: entry.orderId,
    step: entry.step,
    user_input: entry.userInput ?? "none",
    status: entry.status,
    updated_at: new Date().toISOString(),
  }, { onConflict: "call_sid" });

  if (error) {
    console.error("[logStep] failed:", error.code, error.message);
  }
}

export default {
  fetch: async (req: Request) => {
    const url = new URL(req.url);
    let isIvrPath = false;

    try {
      isIvrPath = url.pathname.includes("/dynamic-greeting");

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
      const fromNumber = firstOf(
        params,
        "From",
        "CallFrom",
        "caller_number",
      ) || FALLBACK_FROM;
      const digits = readDigits(params);
      const hasStep = params.has("step");
      const step = (params.get("step") || "welcome").toLowerCase();

      // --------------------------------------------------------------------
      // 1. PASSTHRU — call start notification. Exotel expects 200 + no body.
      // --------------------------------------------------------------------
      if (!hasStep) {
        const callStatus = firstOf(params, "CallStatus") || "incoming";
        console.log(
          `[Passthru] CallSid=${callSid} From=${fromNumber} Status=${callStatus}`,
        );

        const orderId = await lookupOrderId(fromNumber);
        await logStep({
          callSid,
          callerNumber: fromNumber,
          orderId,
          step: "passthru",
          status: "CALL_STARTED",
        });

        return new Response(null, {
          status: 200,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      // --------------------------------------------------------------------
      // 2. DYNAMIC GATHER — must always answer 200 + JSON.
      // --------------------------------------------------------------------
      console.log(
        `[Gather] step=${step} CallSid=${callSid} From=${fromNumber} digits=${digits || "-"}`,
      );

      const orderId = await lookupOrderId(fromNumber);

      switch (step) {
        case "welcome": {
          await logStep({
            callSid,
            callerNumber: fromNumber,
            orderId,
            step: "welcome",
            status: "WELCOME_PLAYED",
          });

          return gather(
            `Welcome to mjunction. We are calling regarding your order number ${orderId}. Press 1 to confirm your order. Press 2 if you have any issues.`,
            {
              repeatText:
                "Sorry, I didn't receive your input. Please press 1 to confirm your order or press 2 if you have any issues.",
            },
          );
        }

        case "address": {
          // Digits collected on the welcome menu arrive with this request.
          await logStep({
            callSid,
            callerNumber: fromNumber,
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
            "Please confirm your delivery address. Press 1 if your address is correct. Press 2 if there are any issues.",
            {
              repeatText:
                "Sorry, I didn't receive your input. Please press 1 if your address is correct or press 2 if there are any issues.",
            },
          );
        }

        // ------------------------------------------------------------------
        // Terminal step. This is the one that was missing: after the caller
        // pressed a key on the address menu, Exotel requested a follow-up
        // step, the switch had no branch for it, and the function answered
        // 404 text/plain — so Exotel hung up mid-call.
        // ------------------------------------------------------------------
        case "done":
        case "goodbye":
        case "confirm":
        case "issue": {
          const issue = digits === "2" || step === "issue";
          await logStep({
            callSid,
            callerNumber: fromNumber,
            orderId,
            step: "done",
            userInput: digits,
            status: issue ? "ADDRESS_ISSUE_RAISED" : "ADDRESS_CONFIRMED",
          });

          return speak(
            issue
              ? "Thank you. We have noted your issue and our team will contact you shortly. Goodbye."
              : "Thank you for confirming. Your order will be delivered as scheduled. Goodbye.",
          );
        }

        default: {
          // Unknown step: still answer 200 + JSON so the call ends cleanly
          // rather than being cut off by Exotel.
          console.warn(`[Gather] unknown step "${step}" — playing fallback`);
          await logStep({
            callSid,
            callerNumber: fromNumber,
            orderId,
            step,
            userInput: digits,
            status: "UNKNOWN_STEP",
          });

          return speak("Thank you for calling mjunction. Goodbye.");
        }
      }
    } catch (err) {
      console.error("Error in dynamic-greeting:", err);

      // Only IVR traffic gets the spoken fallback; anything else gets a real
      // error so genuine bugs stay visible to callers of the HTTP API.
      if (isIvrPath) {
        return speak("Sorry, we are unable to process your call right now. Goodbye.");
      }
      return Response.json({ error: "Internal Server Error" }, { status: 500 });
    }
  },
};
