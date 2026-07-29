import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import {
  startExotelCall,
  type ExotelCallRequest,
} from "./exotel.ts";

export default {
  fetch: withSupabase(
    { auth: ["publishable", "secret"] },
    async (req) => {
      try {
        if (req.method !== "POST") {
          return Response.json(
            {
              success: false,
              error: "Method not allowed",
            },
            {
              status: 405,
            },
          );
        }

        const body = (await req.json()) as ExotelCallRequest;

        const {
          phoneNumber,
          orderId,
          language = "en",
        } = body;

        if (!phoneNumber) {
          return Response.json(
            {
              success: false,
              error: "phoneNumber is required",
            },
            {
              status: 400,
            },
          );
        }

        if (!orderId) {
          return Response.json(
            {
              success: false,
              error: "orderId is required",
            },
            {
              status: 400,
            },
          );
        }

        console.log("Starting Exotel IVR call...");

        const result = await startExotelCall({
          phoneNumber,
          orderId,
          language,
        });

        return Response.json({
          success: true,
          provider: "exotel",
          providerCallRef: result.providerCallRef,
          status: result.status,
          response: result.raw,
        });
      } catch (err) {
        console.error("IVR Engine Error:", err);

        return Response.json(
          {
            success: false,
            error:
              err instanceof Error
                ? err.message
                : "Unknown error",
          },
          {
            status: 500,
          },
        );
      }
    },
  ),
};