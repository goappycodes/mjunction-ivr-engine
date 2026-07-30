import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const supabase = createClient(supabaseUrl, supabaseAnonKey);

export default {
  fetch: async (req: Request) => {
    try {
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method === "OPTIONS") {
        return new Response(null, { headers: { "Access-Control-Allow-Origin": "*" } });
      }

      // ----------------------------------------------------------------------
      // 1. IVR-PASSTHRU ENDPOINT
      // ----------------------------------------------------------------------
      if (path.includes("/dynamic-greeting") && !url.searchParams.has("step")) {
        const bodyText = await req.text();
        const params = new URLSearchParams(bodyText);

        const callSid = params.get("CallSid") || "call_" + Date.now();
        const fromNumber = params.get("From") || params.get("CallFrom") || "08116411177";
        const callStatus = params.get("CallStatus") || "incoming";

        console.log(`[Passthru] CallSid: ${callSid}, From: ${fromNumber}, Status: ${callStatus}`);

        let orderId = "ORD12345";
        const { data: orderData } = await supabase
          .from("orders")
          .select("order_id")
          .eq("phone_number", fromNumber)
          .maybeSingle();

        if (orderData?.order_id) {
          orderId = orderData.order_id;
        }

        await supabase.from("ivr_logs").upsert({
          call_sid: callSid,
          caller_number: fromNumber,
          order_id: orderId,
          step: "passthru",
          user_input: "none",
          status: "CALL_STARTED",
          created_at: new Date().toISOString()
        }, { onConflict: "call_sid" });

        // Exotel Passthru requires a 200 OK with empty body
        return new Response(null, { 
          status: 200,
          headers: { "Access-Control-Allow-Origin": "*" } 
        });
      }

      // ----------------------------------------------------------------------
      // 2. IVR-GATHER ENDPOINT (Dynamic JSON)
      // ----------------------------------------------------------------------
      if (path.includes("/dynamic-greeting") && url.searchParams.has("step")) {
        const step = url.searchParams.get("step") || "welcome";
        const callSid = url.searchParams.get("CallSid") || url.searchParams.get("call_sid") || "";
        const fromNumber = url.searchParams.get("From") || 
                           url.searchParams.get("CallFrom") || 
                           url.searchParams.get("caller_number") || 
                           "08116411177";

        console.log(`[Gather] Step: ${step}, CallSid: ${callSid}, From: ${fromNumber}`);

        let orderId = "ORD12345";
        const { data: orderData } = await supabase
          .from("orders")
          .select("order_id")
          .eq("phone_number", fromNumber)
          .maybeSingle();

        if (orderData?.order_id) {
          orderId = orderData.order_id;
        }

        if (step === "welcome") {
          if (callSid) {
            await supabase.from("ivr_logs").update({
              status: "WELCOME_PLAYED",
              step: "welcome"
            }).eq("call_sid", callSid);
          }

          // Strictly using Response.json ensures application/json header is safely attached
          return Response.json({
            gather_prompt: {
              text: `Welcome to mjunction. We are calling regarding your order number ${orderId}. Press 1 to confirm your order. Press 2 if you have any issues.`
            },
            max_input_digits: 1,
            finish_on_key: "",
            input_timeout: 5,
            repeat_menu: 1,
            repeat_gather_prompt: {
              text: `Sorry, I didn't receive your input. Please press 1 to confirm your order or press 2 if you have any issues.`
            }
          }, { 
            status: 200,
            headers: { 
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*" 
            } 
          });
        }

        if (step === "address") {
          if (callSid) {
            await supabase.from("ivr_logs").update({
              status: "ADDRESS_PROMPT_PLAYED",
              step: "address"
            }).eq("call_sid", callSid);
          }

          return Response.json({
            gather_prompt: {
              text: "Please confirm your delivery address. Press 1 if your address is correct. Press 2 if there are any issues."
            },
            max_input_digits: 1,
            finish_on_key: "",
            input_timeout: 5,
            repeat_menu: 1,
            repeat_gather_prompt: {
              text: "Sorry, I didn't receive your input. Please press 1 if your address is correct or press 2 if there are any issues."
            }
          }, { 
            status: 200,
            headers: { 
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*" 
            } 
          });
        }
      }

      return new Response("Not Found", { status: 404 });

    } catch (err) {
      console.error("Error in Edge Function:", err);
      return Response.json({
        gather_prompt: { text: "An error occurred. Goodbye." },
        max_input_digits: 1
      }, { status: 200 });
    }
  },
};