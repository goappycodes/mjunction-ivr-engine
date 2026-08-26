/**
 * Structured request logging shared by every IVR function.
 *
 * Every request — success, warning, or error — produces exactly one JSON log
 * line via `logEvent()`, carrying the full incoming request (method, url,
 * every param) alongside what was decided/returned. One line per request
 * (not a separate "received" + "responded" pair) keeps volume reasonable
 * while still making every request fully diagnosable from Supabase's log
 * viewer alone, without needing to reproduce the call by hand.
 *
 * Routed to console.error/warn/log by level so Supabase's log-level filter
 * (and any downstream log pipeline) can filter by severity. Also persisted
 * to `ivr_request_log` (fire-and-forget, best-effort) so the same payload is
 * queryable with SQL rather than only readable from the ephemeral function
 * log viewer — every call site already passes `params`/`body`, so this is a
 * pure addition, not a new thing callers have to remember to do.
 */
import { db, waitUntil } from "./db.ts";

export type LogLevel = "success" | "info" | "warning" | "error";

export interface LogFields {
  /** Function emitting the log, e.g. "dynamic-greeting". */
  fn: string;
  level: LogLevel;
  /** Short machine-filterable code, e.g. "step_missing", "welcome_served". */
  event: string;
  /** One-line human summary. */
  message: string;
  /**
   * "inbound" (default) — a request this function received (from Exotel or
   * another caller). "outbound" — a request this function sent (e.g.
   * ivr-engine calling Exotel's Calls/connect, or the Call Details lookup).
   */
  direction?: "inbound" | "outbound";
  method?: string;
  url?: string;
  /** Every param Exotel (or the caller) sent, query + body merged — or, for an outbound log, the payload we sent. */
  params?: Record<string, unknown>;
  /** HTTP status this request is being answered with. */
  status?: number;
  /** Body being sent back — kept small; callers should pass the real payload. */
  body?: unknown;
  callSid?: string;
  callerNumber?: string;
  orderId?: string;
  step?: string;
  durationMs?: number;
  error?: string;
  /**
   * Ad-hoc diagnostic fields alongside `params`/`body` — e.g. a quick-scan
   * summary (content type, which expected keys are present) so a payload can
   * be triaged from the log line without expanding the full params object.
   * Persisted into the DB row's `payload.meta` alongside params/response.
   */
  meta?: Record<string, unknown>;
}

export function logEvent(fields: LogFields): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...fields });
  if (fields.level === "error") console.error(line);
  else if (fields.level === "warning") console.warn(line);
  else console.log(line);

  persistRequestLog(fields);
}

function persistRequestLog(fields: LogFields): void {
  const client = db();
  if (!client) return;

  const payload = fields.params || fields.body !== undefined || fields.meta
    ? {
      ...(fields.params ? { params: fields.params } : {}),
      ...(fields.body !== undefined ? { response: fields.body } : {}),
      ...(fields.meta ? { meta: fields.meta } : {}),
    }
    : null;

  const task = client.from("ivr_request_log").insert({
    fn: fields.fn,
    direction: fields.direction ?? "inbound",
    event: fields.event,
    level: fields.level,
    method: fields.method ?? null,
    url: fields.url ?? null,
    status: fields.status ?? null,
    call_sid: fields.callSid ?? null,
    order_id: fields.orderId ?? null,
    message: fields.message,
    payload,
    error: fields.error ?? null,
    duration_ms: fields.durationMs ?? null,
  }).then(({ error }: { error: { message: string } | null }) => {
    if (error) console.error("[persistRequestLog] insert failed:", error.message);
  });

  waitUntil(task as Promise<unknown>);
}
