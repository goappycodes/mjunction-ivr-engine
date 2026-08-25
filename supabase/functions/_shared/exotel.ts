/**
 * Exotel Call Details API — the fallback Exotel's own webhook docs call for:
 * "StatusCallback delivery may be delayed or fail... implement fallback
 * logic using the Call Details API to ensure you capture all call data."
 *
 * GET https://<host>/v1/Accounts/<sid>/Calls/<CallSid>.json
 * Basic auth with <api_key>:<api_token> — same credentials as the outbound
 * Calls/connect request in ivr-engine/exotel.ts. Duplicated here (rather than
 * imported from there) so this shared module has no dependency on a single
 * function's directory; every caller of `_shared/*` already follows that
 * convention.
 */

import { logEvent } from "./logging.ts";

function resolveExotelHost(subdomain: string): string {
  const host = subdomain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

  if (host.endsWith("exotel.com")) return host;      // api.in.exotel.com
  if (host.endsWith(".exotel")) return `${host}.com`; // in.exotel
  return `${host}.exotel.com`;                        // api
}

export interface ExotelCallDetails {
  status: string;
  recordingUrl: string | null;
  durationSeconds: number | null;
}

/**
 * Returns null (rather than throwing) on missing config or a failed/unknown
 * response — callers here are a background reconciliation job, not a live
 * call Exotel is waiting on, so "skip this one and log it" is the right
 * failure mode, not an unhandled exception that kills the whole batch.
 */
export async function getCallDetails(
  callSid: string,
): Promise<ExotelCallDetails | null> {
  const apiKey = Deno.env.get("EXOTEL_API_KEY");
  const apiToken = Deno.env.get("EXOTEL_API_TOKEN");
  const accountSid = Deno.env.get("EXOTEL_ACCOUNT_SID");
  const subdomain = Deno.env.get("EXOTEL_SUBDOMAIN");

  if (!apiKey || !apiToken || !accountSid || !subdomain || !callSid) {
    console.error(
      "[getCallDetails] missing Exotel credentials or callSid; skipping",
    );
    return null;
  }

  const host = resolveExotelHost(subdomain);
  const endpoint =
    `https://${host}/v1/Accounts/${accountSid}/Calls/${callSid}.json`;
  const authHeader = `Basic ${btoa(`${apiKey}:${apiToken}`)}`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: { "Authorization": authHeader },
    });
  } catch (err) {
    console.error(`[getCallDetails] fetch failed for ${callSid}:`, err);
    return null;
  }

  const responseText = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(responseText);
  } catch (_e) {
    console.error(
      `[getCallDetails] unparseable response for ${callSid} (HTTP ${response.status}): ${responseText.slice(0, 200)}`,
    );
    logEvent({
      fn: "reconcile-calls",
      level: "error",
      event: "exotel_call_details_unparseable",
      message: `Call Details response unparseable (HTTP ${response.status})`,
      direction: "outbound",
      method: "GET",
      url: endpoint,
      status: response.status,
      callSid,
      body: responseText.slice(0, 500),
    });
    return null;
  }

  logEvent({
    fn: "reconcile-calls",
    level: response.ok ? "success" : "error",
    event: "exotel_call_details_request",
    message: `Call Details -> HTTP ${response.status}`,
    direction: "outbound",
    method: "GET",
    url: endpoint,
    status: response.status,
    callSid,
    body: parsed,
  });

  if (!response.ok) {
    const restException = parsed?.RestException as
      | { Message?: string; Code?: number }
      | undefined;
    console.error(
      `[getCallDetails] Exotel rejected ${callSid} (HTTP ${response.status}): ${
        restException?.Message ?? responseText.slice(0, 200)
      }`,
    );
    return null;
  }

  const call = (parsed?.Call ?? {}) as {
    Status?: string;
    RecordingUrl?: string;
    Duration?: string | number;
  };

  if (!call.Status) {
    console.error(`[getCallDetails] no Call.Status in response for ${callSid}`);
    return null;
  }

  const durationRaw = call.Duration != null ? String(call.Duration) : "";
  const durationSeconds = /^\d+$/.test(durationRaw) ? Number(durationRaw) : null;

  return {
    status: call.Status,
    recordingUrl: call.RecordingUrl?.trim() || null,
    durationSeconds,
  };
}
