export interface ExotelCallRequest {
  phoneNumber: string;
  orderId: string;
  language?: string;
}

export interface ExotelCallResponse {
  providerCallRef: string;
  status: string;
  raw: unknown;
}

/**
 * Normalises EXOTEL_SUBDOMAIN into a hostname.
 *
 * The previous template was `https://${subdomain}.api.exotel.com`, which is
 * wrong for every documented value: the configured `api.in.exotel.com` became
 * `api.in.exotel.com.api.exotel.com`, and the README's `api` became
 * `api.api.exotel.com`. Exotel's real hosts are `api.exotel.com` (Singapore)
 * and `api.in.exotel.com` (India), so accept either a full host or a bare
 * subdomain.
 */
export function resolveExotelHost(subdomain: string): string {
  const host = subdomain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

  if (host.endsWith("exotel.com")) return host;   // api.in.exotel.com
  if (host.endsWith(".exotel")) return `${host}.com`; // in.exotel
  return `${host}.exotel.com`;                     // api
}

export async function startExotelCall(
  request: ExotelCallRequest,
): Promise<ExotelCallResponse> {
  const apiKey = Deno.env.get("EXOTEL_API_KEY");
  const apiToken = Deno.env.get("EXOTEL_API_TOKEN");
  const accountSid = Deno.env.get("EXOTEL_ACCOUNT_SID");
  const subdomain = Deno.env.get("EXOTEL_SUBDOMAIN");
  const callerId = Deno.env.get("EXOTEL_CALLER_ID");
  const appId = Deno.env.get("EXOTEL_APP_ID") ?? "1301090";

  if (!apiKey || !apiToken || !accountSid || !subdomain || !callerId) {
    throw new Error(
      "Missing required Exotel environment variables (EXOTEL_API_KEY, EXOTEL_API_TOKEN, EXOTEL_ACCOUNT_SID, EXOTEL_SUBDOMAIN, EXOTEL_CALLER_ID)",
    );
  }

  const host = resolveExotelHost(subdomain);
  const endpoint = `https://${host}/v1/Accounts/${accountSid}/Calls/connect.json`;
  const flowUrl = `https://my.exotel.com/${accountSid}/exoml/start_voice/${appId}`;

  const params = new URLSearchParams();
  params.append("From", request.phoneNumber);
  params.append("CallerId", callerId);
  params.append("Url", flowUrl);
  params.append("CustomField", request.orderId);

  const authHeader = `Basic ${btoa(`${apiKey}:${apiToken}`)}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const responseText = await response.text();
  let parsedJson: Record<string, any>;

  try {
    parsedJson = JSON.parse(responseText);
  } catch (_e) {
    throw new Error(`Failed to parse Exotel API response: ${responseText}`);
  }

  if (!response.ok) {
    const errorMessage =
      parsedJson?.RestException?.Message ??
      `Exotel API call failed with HTTP status ${response.status}`;
    throw new Error(errorMessage);
  }

  const callData = parsedJson?.Call ?? {};
  const providerCallRef = callData?.Sid ?? "";
  const status = callData?.Status ?? "queued";

  if (!providerCallRef) {
    throw new Error(`Exotel API did not return a valid Call Sid: ${responseText}`);
  }

  return {
    providerCallRef,
    status,
    raw: parsedJson,
  };
}