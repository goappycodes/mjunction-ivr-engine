/**
 * Exotel Voice v1 — "connect a number to a call flow".
 *
 * POST https://<host>/v1/Accounts/<sid>/Calls/connect.json
 * Basic auth with <api_key>:<api_token>.
 *
 * Required: From, CallerId, Url
 * Optional: CallType, TimeLimit, TimeOut, StatusCallback, StatusCallbackEvents,
 *           CustomField, Record
 */

export interface ExotelCallRequest {
  phoneNumber: string;
  /** Travels with the call as CustomField and is echoed back to every applet. */
  orderId: string;
  language?: string;
  statusCallbackUrl?: string;
  record?: boolean;
}

export interface ExotelCallResponse {
  providerCallRef: string;
  status: string;
  raw: unknown;
}

/** Documented Call.Status values for this endpoint. */
export const CALL_STATUSES = [
  "queued",
  "in-progress",
  "completed",
  "failed",
  "busy",
  "no-answer",
] as const;

/**
 * Normalises EXOTEL_SUBDOMAIN into a hostname.
 *
 * The documented hosts are `api.in.exotel.com` (India/Mumbai) and
 * `api.exotel.com` (Singapore). The original template was
 * `https://${subdomain}.api.exotel.com`, which mangled every valid value: the
 * configured `api.in.exotel.com` became `api.in.exotel.com.api.exotel.com`.
 */
export function resolveExotelHost(subdomain: string): string {
  const host = subdomain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

  if (host.endsWith("exotel.com")) return host;      // api.in.exotel.com
  if (host.endsWith(".exotel")) return `${host}.com`; // in.exotel
  return `${host}.exotel.com`;                        // api
}

export async function startExotelCall(
  request: ExotelCallRequest,
): Promise<ExotelCallResponse> {
  const apiKey = Deno.env.get("EXOTEL_API_KEY");
  const apiToken = Deno.env.get("EXOTEL_API_TOKEN");
  const accountSid = Deno.env.get("EXOTEL_ACCOUNT_SID");
  const subdomain = Deno.env.get("EXOTEL_SUBDOMAIN");
  const callerId = Deno.env.get("EXOTEL_CALLER_ID");
  const appId = Deno.env.get("EXOTEL_APP_ID");

  const missing = [
    ["EXOTEL_API_KEY", apiKey],
    ["EXOTEL_API_TOKEN", apiToken],
    ["EXOTEL_ACCOUNT_SID", accountSid],
    ["EXOTEL_SUBDOMAIN", subdomain],
    ["EXOTEL_CALLER_ID", callerId],
    ["EXOTEL_APP_ID", appId],
  ].filter(([, v]) => !v).map(([k]) => k);

  if (missing.length) {
    throw new Error(
      `Missing required Exotel environment variables: ${missing.join(", ")}`,
    );
  }

  const host = resolveExotelHost(subdomain!);
  const endpoint = `https://${host}/v1/Accounts/${accountSid}/Calls/connect.json`;

  // Documented flow URL format. Kept as http:// deliberately — this is the exact
  // form Exotel documents for the Url parameter, and it is dereferenced inside
  // Exotel rather than fetched by us.
  const flowUrl =
    `http://my.exotel.com/${accountSid}/exoml/start_voice/${appId}`;

  // Built manually rather than via URLSearchParams: Exotel's own documented
  // curl example sends `StatusCallbackEvents[0]=terminal` with literal,
  // unencoded brackets, but URLSearchParams percent-encodes them to
  // `StatusCallbackEvents%5B0%5D`, which Exotel's endpoint rejects with
  // "Invalid 'StatusCallbackEvents' specified" — it doesn't URL-decode the
  // key before matching it against the array-parameter name.
  const bodyParts: string[] = [];
  const addParam = (key: string, value: string) => {
    bodyParts.push(`${key}=${encodeURIComponent(value)}`);
  };

  addParam("From", request.phoneNumber);
  addParam("CallerId", callerId!);
  addParam("Url", flowUrl);
  // The order id rides along here and Exotel echoes it back as `CustomField` on
  // every applet request, which is how dynamic-greeting knows which order to
  // build the prompt from.
  addParam("CustomField", request.orderId);
  // Order-confirmation calls are transactional, which is what `trans` declares.
  addParam("CallType", "trans");
  addParam("Record", String(request.record ?? false));

  if (request.statusCallbackUrl) {
    addParam("StatusCallback", request.statusCallbackUrl);
    bodyParts.push("StatusCallbackEvents[0]=terminal");
  }

  const authHeader = `Basic ${btoa(`${apiKey}:${apiToken}`)}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: bodyParts.join("&"),
  });

  const responseText = await response.text();
  let parsedJson: Record<string, unknown>;

  try {
    parsedJson = JSON.parse(responseText);
  } catch (_e) {
    throw new Error(
      `Failed to parse Exotel API response (HTTP ${response.status}): ${responseText}`,
    );
  }

  if (!response.ok) {
    const restException = parsedJson?.RestException as
      | { Message?: string; Code?: number; Status?: number }
      | undefined;

    // Attribute the failure to Exotel explicitly. Passing Exotel's bare message
    // through made an Exotel credential rejection ("Unauthorized; ", code
    // 34010) look like a Supabase authorization problem.
    const detail = restException?.Message?.trim().replace(/;$/, "") ??
      responseText.slice(0, 200);
    const code = restException?.Code ? `, code ${restException.Code}` : "";

    throw new Error(
      `Exotel rejected the request (HTTP ${response.status}${code}): ${detail}` +
        (response.status === 401
          ? " — check the EXOTEL_API_KEY / EXOTEL_API_TOKEN / EXOTEL_ACCOUNT_SID secrets"
          : ""),
    );
  }

  const callData = (parsedJson?.Call ?? {}) as { Sid?: string; Status?: string };
  const providerCallRef = callData.Sid ?? "";

  if (!providerCallRef) {
    throw new Error(`Exotel API did not return a Call Sid: ${responseText}`);
  }

  // A 200 confirms Exotel accepted the request, not that the call connected —
  // the real outcome arrives via StatusCallback or the Call Details API.
  return {
    providerCallRef,
    status: callData.Status ?? "queued",
    raw: parsedJson,
  };
}
