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

  // EXOTEL_SUBDOMAIN may be a bare cluster prefix ("api") or a full host
  // ("api.exotel.com") — accept either so a full host isn't double-appended.
  const apiHost = subdomain.includes("exotel.com")
    ? subdomain
    : `${subdomain}.exotel.com`;
  const endpoint = `https://${apiHost}/v1/Accounts/${accountSid}/Calls/connect.json`;
  const flowUrl = `http://my.exotel.com/${accountSid}/exoml/start_voice/${appId}`;

  const params = new URLSearchParams();
  params.append("From", request.phoneNumber);
  params.append("CallerId", callerId);
  params.append("Url", flowUrl);
  params.append("CustomField", request.orderId);

  const authHeader = `Basic ${btoa(`${apiKey}:${apiToken}`)}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: authHeader,
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
    throw new Error(
      `Exotel API did not return a valid Call Sid: ${responseText}`,
    );
  }

  return {
    providerCallRef,
    status,
    raw: parsedJson,
  };
}
