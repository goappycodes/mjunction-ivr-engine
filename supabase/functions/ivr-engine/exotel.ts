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

import { logEvent } from "../_shared/logging.ts";

export interface ExotelCallRequest {
  phoneNumber: string;
  /**
   * Travels with the call as CustomField and is echoed back to every applet.
   * Carries the order id *and* which of the two scripts this call is running
   * (`<unique_id>|oc` / `<unique_id>|dc`) — see `_shared/flow.ts` for why both
   * scripts share one Exotel app.
   */
  customField: string;
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

  const bodyParts: string[] = [];
  // Kept alongside bodyParts (rather than parsed back out of it) so the
  // outbound payload can be logged as a real object, not a re-decoded
  // querystring.
  const bodyFields: Record<string, string> = {};
  const addParam = (key: string, value: string) => {
    bodyParts.push(`${key}=${encodeURIComponent(value)}`);
    bodyFields[key] = value;
  };

  addParam("From", request.phoneNumber);
  addParam("CallerId", callerId!);
  addParam("Url", flowUrl);
  // The order id (plus the flow suffix) rides along here and Exotel echoes it
  // back as `CustomField` on every applet request, which is how
  // dynamic-greeting knows which order to build the prompt from and which of
  // the two scripts to read.
  addParam("CustomField", request.customField);
  // Both scripts are transactional, which is what `trans` declares — this is
  // Exotel's own call classification, unrelated to our order/delivery split.
  addParam("CallType", "trans");
  addParam("Record", String(request.record ?? false));

  // `StatusCallbackEvents` is omitted: this account's Calls/connect (v1)
  // rejects it outright with "Invalid 'StatusCallbackEvents' specified"
  // regardless of format (tried both URL-encoded and literal
  // `StatusCallbackEvents[0]=terminal` bracket syntax, both rejected) — it's
  // likely a v3-only parameter per Exotel's docs, not supported here.
  // `StatusCallback` alone still gets a terminal-status POST from Exotel by
  // default, so status-callback/index.ts keeps working without it.
  if (request.statusCallbackUrl) {
    addParam("StatusCallback", request.statusCallbackUrl);
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
    logEvent({
      fn: "ivr-engine",
      level: "error",
      event: "exotel_connect_response_unparseable",
      message: `Exotel connect response unparseable (HTTP ${response.status})`,
      direction: "outbound",
      method: "POST",
      url: endpoint,
      status: response.status,
      params: bodyFields,
      body: responseText.slice(0, 500),
    });
    throw new Error(
      `Failed to parse Exotel API response (HTTP ${response.status}): ${responseText}`,
    );
  }

  // Logged once here, regardless of response.ok, so the outbound payload is
  // captured for both a successful call placement and a rejected one — the
  // error-handling below still runs unchanged after this.
  logEvent({
    fn: "ivr-engine",
    level: response.ok ? "success" : "error",
    event: "exotel_connect_request",
    message: `Calls/connect -> HTTP ${response.status}`,
    direction: "outbound",
    method: "POST",
    url: endpoint,
    status: response.status,
    params: bodyFields,
    body: parsedJson,
  });

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
