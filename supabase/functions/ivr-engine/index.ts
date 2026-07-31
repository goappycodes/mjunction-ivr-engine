import "@supabase/functions-js/edge-runtime.d.ts";
import {
  startExotelCall,
  type ExotelCallRequest,
} from "./exotel.ts";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

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
        return Response.json(
          { success: false, error: "Method not allowed" },
          { status: 405, headers: JSON_HEADERS },
        );
      }

      let body: Partial<ExotelCallRequest>;
      try {
        body = await req.json();
      } catch (_e) {
        return Response.json(
          { success: false, error: "Invalid JSON body" },
          { status: 400, headers: JSON_HEADERS },
        );
      }

      const phoneNumber = body?.phoneNumber?.trim();
      const orderId = body?.orderId?.trim();

      if (!phoneNumber || !orderId) {
        return Response.json(
          { success: false, error: "phoneNumber and orderId are required" },
          { status: 400, headers: JSON_HEADERS },
        );
      }

      // The previous version parsed the body and then fell off the end of the
      // handler without ever calling startExotelCall or returning a Response,
      // so the worker resolved to `undefined` and the request failed.
      const result = await startExotelCall({
        phoneNumber,
        orderId,
        language: body?.language,
      });

      return Response.json(
        { success: true, ...result },
        { status: 200, headers: JSON_HEADERS },
      );
    } catch (error) {
      console.error("Error in ivr-engine:", error);
      return Response.json(
        { success: false, error: (error as Error).message },
        { status: 500, headers: JSON_HEADERS },
      );
    }
  },
};
