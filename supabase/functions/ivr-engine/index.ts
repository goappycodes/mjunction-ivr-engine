import "@supabase/functions-js/edge-runtime.d.ts";
import { 
  startExotelCall, 
  type ExotelCallRequest 
} from "./exotel.ts";

export default {
  fetch: async (req: Request) => {
    try {
      if (req.method !== "POST") {
        return Response.json(
          { success: false, error: "Method not allowed" },
          { status: 405 }
        );
      }
      
      // Parse your JSON body here
      const body = await req.json();
      
      // ... continue with your startExotelCall logic ...

    } catch (error) {
      return Response.json(
        { success: false, error: (error as Error).message },
        { status: 500 }
      );
    }
  }
};