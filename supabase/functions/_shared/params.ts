/**
 * Shared Exotel request-parameter parsing.
 *
 * Exotel sends applet/callback parameters as a query string on GET; POST
 * bodies are also accepted so endpoints stay testable and tolerant of
 * Passthru-style configuration, but query params always win. Both
 * `dynamic-greeting` and `ivr-status-callback` receive Exotel requests shaped
 * this way, so the parsing lives here once instead of twice.
 */

export async function readParams(
  req: Request,
  url: URL,
): Promise<URLSearchParams> {
  const params = new URLSearchParams(url.searchParams);

  if (req.method === "POST" || req.method === "PUT") {
    const raw = await req.text();
    if (raw) {
      const contentType = req.headers.get("content-type") ?? "";
      try {
        if (contentType.includes("application/json")) {
          for (const [k, v] of Object.entries(JSON.parse(raw))) {
            if (!params.has(k)) params.append(k, String(v));
          }
        } else {
          for (const [k, v] of new URLSearchParams(raw)) {
            if (!params.has(k)) params.append(k, v);
          }
        }
      } catch (_e) {
        console.warn("[readParams] unparseable body ignored");
      }
    }
  }

  return params;
}

export function firstOf(params: URLSearchParams, ...keys: string[]): string {
  for (const key of keys) {
    const value = params.get(key);
    if (value) return value.trim();
  }
  return "";
}

/**
 * Exotel documents that `digits` arrives wrapped in double quotes and must be
 * trimmed, e.g. `"1"`.
 */
export function readDigits(params: URLSearchParams): string {
  return firstOf(params, "digits", "Digits", "dtmf", "DTMF")
    .replace(/["\s]/g, "");
}

/** Every param Exotel sent, flattened for JSON/jsonb storage. */
export function paramsToObject(
  params: URLSearchParams,
): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const [k, v] of params) obj[k] = v;
  return obj;
}
