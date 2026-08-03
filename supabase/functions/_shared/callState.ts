/**
 * The two independent state tracks kept per call.
 *
 * `IvrState` is the furthest point the caller has reached in the greeting
 * conversation — set by `dynamic-greeting` on every applet request and stored
 * in `ivr_logs.status` / `ivr_call_events.status`.
 *
 * `CallStatus` is Exotel's telephony-level outcome for the call itself — set
 * once by `ivr-engine` when the call is placed (`queued`), and finalized by
 * `ivr-status-callback` when Exotel reports the call ended. Stored in
 * `ivr_logs.call_status`.
 *
 * They are tracked separately, not merged into one flow, because they can
 * diverge: a call can reach `ADDRESS_CONFIRMED` and still end up `failed` if
 * the line drops before the closing message, or Exotel can report `completed`
 * for a call that never answered a single Gather prompt.
 */

export const IVR_STATES = {
  CALL_STARTED: "CALL_STARTED",
  WELCOME_SERVED: "WELCOME_SERVED",
  WELCOME_SERVED_NO_ORDER: "WELCOME_SERVED_NO_ORDER",
  WELCOME_SERVED_NO_STEP: "WELCOME_SERVED_NO_STEP",
  ORDER_CONFIRMED: "ORDER_CONFIRMED",
  ORDER_ISSUE_RAISED: "ORDER_ISSUE_RAISED",
  ADDRESS_PROMPT_SERVED: "ADDRESS_PROMPT_SERVED",
  ADDRESS_CONFIRMED: "ADDRESS_CONFIRMED",
  ADDRESS_ISSUE_RAISED: "ADDRESS_ISSUE_RAISED",
  UNKNOWN_STEP: "UNKNOWN_STEP",
} as const;

export type IvrState = typeof IVR_STATES[keyof typeof IVR_STATES];

/** Exotel's documented Call.Status values (Calls/connect and StatusCallback). */
export const CALL_STATUS = {
  QUEUED: "queued",
  RINGING: "ringing",
  IN_PROGRESS: "in-progress",
  COMPLETED: "completed",
  FAILED: "failed",
  BUSY: "busy",
  NO_ANSWER: "no-answer",
} as const;

export type CallStatus = typeof CALL_STATUS[keyof typeof CALL_STATUS];

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  CALL_STATUS.COMPLETED,
  CALL_STATUS.FAILED,
  CALL_STATUS.BUSY,
  CALL_STATUS.NO_ANSWER,
]);

/** Case-insensitive match against the known Call.Status vocabulary. */
export function normalizeCallStatus(raw: string): CallStatus | null {
  const value = raw.trim().toLowerCase();
  return (Object.values(CALL_STATUS) as string[]).includes(value)
    ? (value as CallStatus)
    : null;
}

/** True once the call has ended, in any outcome — completed, failed, busy, or unanswered. */
export function isTerminalCallStatus(raw: string): boolean {
  return TERMINAL_STATUSES.has(raw.trim().toLowerCase());
}
