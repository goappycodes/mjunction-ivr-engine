import "@supabase/functions-js/edge-runtime.d.ts";

// Exotel's ExoML flow / App Bazaar applet calls this URL with call status,
// DTMF input, etc. Exotel does not sign requests, so this is unauthenticated
// by design (see [functions.exotel-webhook] verify_jwt = false).
export default {
  fetch: async (req: Request) => {
    const url = new URL(req.url);
    const query = Object.fromEntries(url.searchParams.entries());

    let body: unknown = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const contentType = req.headers.get("content-type") ?? "";
      try {
        if (contentType.includes("application/json")) {
          body = await req.json();
        } else if (
          contentType.includes("application/x-www-form-urlencoded") ||
          contentType.includes("multipart/form-data")
        ) {
          body = Object.fromEntries((await req.formData()).entries());
        } else {
          body = await req.text();
        }
      } catch (err) {
        console.error("Exotel webhook: failed to parse body:", err);
      }
    }

    console.log("Exotel webhook received:", {
      method: req.method,
      query,
      body,
    });

    return Response.json({ success: true, message: "Webhook received" });
  },
};
