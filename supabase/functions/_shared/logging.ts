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
 * (and any downstream log pipeline) can filter by severity.
 */

export type LogLevel = "success" | "warning" | "error";

export interface LogFields {
  /** Function emitting the log, e.g. "dynamic-greeting". */
  fn: string;
  level: LogLevel;
  /** Short machine-filterable code, e.g. "step_missing", "welcome_served". */
  event: string;
  /** One-line human summary. */
  message: string;
  method?: string;
  url?: string;
  /** Every param Exotel (or the caller) sent, query + body merged. */
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
}

export function logEvent(fields: LogFields): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...fields });
  if (fields.level === "error") console.error(line);
  else if (fields.level === "warning") console.warn(line);
  else console.log(line);
}
