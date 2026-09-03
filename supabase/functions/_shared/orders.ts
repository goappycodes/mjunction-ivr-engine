/**
 * Shared data access for the IVR functions.
 *
 * The "order" this whole flow revolves around IS a recipient row in
 * mjunction's own `recipients` table — the same table the admin panel
 * (mjunction) reads and writes. There is no separate `orders` table anymore:
 * a recipient's stable `unique_id` is what travels through Exotel as
 * `CustomField`/`orderId`, and a call against it writes to the exact same
 * `call_attempts` / `recipient_events` / `recipients.status` that a mock call
 * placed from the admin panel would. That is what makes a recipient's
 * timeline, escalations queue and unreachable queue pick up real IVR activity
 * with zero changes on the mjunction side.
 *
 * `ivr_logs` / `ivr_call_events` (this repo's own tables) remain the
 * granular, per-applet-request technical trace — useful for diagnosing a
 * misconfigured Exotel flow — separate from the business-level record that
 * lives in `call_attempts`.
 */
import {
  canTransition,
  type CallOutcome,
  deliveryConfirmationStatusFor,
  orderConfirmationStatusFor,
  type RecipientStatus,
} from "./status.ts";
import { db, functionsUrl, serviceRoleKey, waitUntil } from "./db.ts";

export { db, functionsUrl };
export type { CallOutcome, RecipientStatus };

/**
 * The "order" as seen by the IVR flow. Field names are kept in the vocabulary
 * Exotel/the call script already uses (order_id, delivery_address, ...) even
 * though every one of them is now a `recipients` column under a different
 * name — that mapping lives here and nowhere else.
 */
export interface OrderRecord {
  order_id: string;
  phone_number: string;
  customer_name: string | null;
  delivery_address: string | null;
  product_name: string | null;
  status: RecipientStatus;
  /** Internal — `recipients.id`, needed for every write below. */
  recipient_id: string;
  company_name: string | null;
  /** E.164 — the telecaller who owns this order; shown in mjunction, not dialled by the IVR. */
  telecaller_phone: string | null;
}

const RECIPIENT_COLUMNS = [
  "order_id:unique_id",
  "phone_number:contact_no_e164",
  "customer_name",
  "delivery_address:address",
  "product_name",
  "status",
  "recipient_id:id",
  "company_name",
  "telecaller_phone",
].join(", ");

/**
 * Exotel abandons an application URL that has not answered within 5 seconds and
 * drops the caller. Every database path is capped well short of that.
 */
export const DB_TIMEOUT_MS = 1500;

export async function withTimeout<T>(
  // PromiseLike, not Promise: a Postgrest query builder (e.g. the chains
  // passed in by the lookups below) implements .then() but not the rest of
  // the Promise interface, so it isn't assignable to Promise<T> even though
  // Promise.race below accepts it natively.
  work: PromiseLike<T>,
  fallback: T,
  label: string,
): Promise<T> {
  let timer: number | undefined;
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[${label}] exceeded ${DB_TIMEOUT_MS}ms; using fallback`);
      resolve(fallback);
    }, DB_TIMEOUT_MS);
  });

  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface OrderLookup {
  order: OrderRecord | null;
  /** Set only when the query itself failed, never for a simple miss. */
  error: string | null;
}

/**
 * Look up the recipient this order id resolves to, keeping "does not exist"
 * distinguishable from "the query failed". Callers that must report the real
 * fault (ivr-engine) use this; callers that must never drop a live call
 * (dynamic-greeting) use `getOrderById`, which collapses both cases to null
 * on purpose.
 */
export async function lookupOrderById(orderId: string): Promise<OrderLookup> {
  const client = db();
  if (!client) {
    return { order: null, error: "No Supabase key configured" };
  }

  const { data, error } = await client
    .from("recipients")
    .select(RECIPIENT_COLUMNS)
    .eq("unique_id", orderId)
    .maybeSingle();

  if (error) {
    console.error("[lookupOrderById] failed:", error.code, error.message);
    return { order: null, error: `${error.code}: ${error.message}` };
  }

  return { order: (data as unknown as OrderRecord | null) ?? null, error: null };
}

/** Primary path: the order id travelled with the call via Exotel CustomField. */
export async function getOrderById(orderId: string): Promise<OrderRecord | null> {
  const { order } = await lookupOrderById(orderId);
  return order;
}

/**
 * Inbound-call path: no CustomField exists, so fall back to the caller's
 * number. Callers arrive as `08116411177`, `8116411177` or `+918116411177`
 * depending on the circuit, so match on the last 10 digits.
 *
 * A phone number is only unique per-campaign in `recipients` (the same
 * person can legitimately be a recipient in two campaigns), so a phone-only
 * match can be genuinely ambiguous. Most-recently-updated wins — the
 * recipient most likely to be the subject of a callback — rather than an
 * arbitrary row order.
 */
export async function getOrderByPhone(phone: string): Promise<OrderRecord | null> {
  const client = db();
  if (!client) return null;

  const national = phone.replace(/\D/g, "").slice(-10);
  if (!national) return null;

  const { data, error } = await client
    .from("recipients")
    .select(RECIPIENT_COLUMNS)
    // PostgREST uses `*` as the LIKE wildcard in filter strings, not `%`.
    .or(`contact_no_e164.eq.${phone},contact_no_e164.like.*${national}`)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[getOrderByPhone] failed:", error.code, error.message);
    return null;
  }
  return (data as unknown as OrderRecord | null) ?? null;
}

/**
 * Middle fallback: `ivr-engine` records the order id against the CallSid when it
 * places the call, so a later applet can recover it even if CustomField is
 * absent from that particular request.
 */
export async function getOrderIdByCallSid(callSid: string): Promise<string | null> {
  const client = db();
  if (!client || !callSid) return null;

  const { data, error } = await client
    .from("ivr_logs")
    .select("order_id")
    .eq("call_sid", callSid)
    .maybeSingle();

  if (error) {
    console.error("[getOrderIdByCallSid] failed:", error.code, error.message);
    return null;
  }
  return data?.order_id ?? null;
}

/** Fresh read of a recipient's current status, used just before finalizing a call. */
export async function getRecipientStatus(
  recipientId: string,
): Promise<RecipientStatus | null> {
  const client = db();
  if (!client || !recipientId) return null;

  const { data, error } = await client
    .from("recipients")
    .select("status")
    .eq("id", recipientId)
    .maybeSingle();

  if (error) {
    console.error("[getRecipientStatus] failed:", error.code, error.message);
    return null;
  }
  return (data?.status as RecipientStatus | undefined) ?? null;
}

export interface CallLogEntry {
  callSid: string;
  callerNumber?: string;
  orderId?: string;
  step: string;
  userInput?: string;
  status: string;
  /** Which applet Exotel appears to have called from; recorded for diagnosis. */
  appletHint?: string;
  /** Links this call_sid to the call_attempts row it belongs to (see startCallAttempt). */
  callAttemptId?: string;
}

export async function upsertCallLog(entry: CallLogEntry): Promise<void> {
  const client = db();
  if (!client || !entry.callSid) return;

  const row: Record<string, unknown> = {
    call_sid: entry.callSid,
    step: entry.step,
    status: entry.status,
    user_input: entry.userInput ?? "none",
    updated_at: new Date().toISOString(),
  };
  // Never overwrite a known caller/order/attempt with undefined on a later step.
  if (entry.callerNumber) row.caller_number = entry.callerNumber;
  if (entry.orderId) row.order_id = entry.orderId;
  if (entry.callAttemptId) row.call_attempt_id = entry.callAttemptId;

  const { error } = await client
    .from("ivr_logs")
    .upsert(row, { onConflict: "call_sid" });

  if (error) {
    console.error("[upsertCallLog] failed:", error.code, error.message);
  }

  // Append the step as well. `ivr_logs` keeps only the latest state per call
  // (unique call_sid + upsert), so the ordered trace lives here.
  const { error: eventError } = await client.from("ivr_call_events").insert({
    call_sid: entry.callSid,
    step: entry.step,
    user_input: entry.userInput ?? "none",
    status: entry.status,
    applet_hint: entry.appletHint ?? null,
  });

  if (eventError) {
    console.error(
      "[upsertCallLog] event insert failed:",
      eventError.code,
      eventError.message,
    );
  }
}

/**
 * Fire-and-forget the audit write so it never counts against Exotel's 5s budget.
 * `EdgeRuntime.waitUntil` keeps the worker alive until it finishes, which a bare
 * un-awaited promise does not guarantee.
 */
export function logCallStep(entry: CallLogEntry): void {
  const task = upsertCallLog(entry).catch((err) => {
    console.error("[logCallStep] threw:", err);
  });
  waitUntil(task);
}

/**
 * The digit pressed on an earlier Gather menu arrives with the *next*
 * applet's request (Exotel's echo-on-next-request behaviour — see the
 * dynamic-greeting header comment). By the time the call reaches its last
 * step, that earlier digit only survives in the append-only `ivr_call_events`
 * trace (`ivr_logs` has already been overwritten with the latest step). This
 * reads it back so the final outcome can take both answers into account.
 */
/**
 * Order-confirmation outcome from the menu digit.
 *
 * There is one menu now, so there is one digit: "1" confirms the delivery
 * address, "2" asks to change it. Both scripts read the digit the same way
 * (see `resolveDeliveryConfirmationOutcome`), which is what lets them share a
 * single Exotel flow graph — `_shared/flow.ts`.
 *
 * This is the fallback path only. `dynamic-greeting` sends `update-order-status`
 * an explicit outcome on both terminal steps, because the branch Exotel routed
 * to already says which digit was pressed; this resolver runs when the digit
 * is all that was supplied (a manual retry, admin tooling).
 *
 * Matches the wording the call script and OUTCOME_LABELS (mjunction) already
 * commit to: `confirmed` = "press 1", `issue_raised` = "press 2".
 */
export function resolveOrderConfirmationOutcome(digit: string): CallOutcome {
  // "Press 2" means this order needs a human — an address to be changed. See
  // the ISSUE_RAISED note in _shared/status.ts.
  return digit === "2" ? "issue_raised" : "confirmed";
}

/**
 * Delivery-confirmation outcome from the same single menu digit, read against
 * the delivery script instead of the address one ("did you receive it, and is
 * it in good condition"). The shape matches because both scripts run on the
 * same Exotel flow graph — see `_shared/flow.ts` — but the meaning does not,
 * which is why this stays a separate function rather than a shared one with a
 * flag:
 *
 *   - "2" (not received, or damaged/wrong) -> `issue_raised`. A non-delivery
 *     is an issue with this delivery, not an unreachable call.
 *   - otherwise -> a clean `confirmed`, which is what seals the VOC.
 */
export function resolveDeliveryConfirmationOutcome(digit: string): CallOutcome {
  return digit === "2" ? "issue_raised" : "confirmed";
}

// ---------------------------------------------------------------------------
// call_attempts lifecycle — the same table + shape the mock provider writes
// (src/lib/domain/call-flow.ts in mjunction), just opened at dial time and
// finalized later instead of written in one shot, because a live Exotel call
// spans many independent HTTP requests instead of one synchronous function
// call.
// ---------------------------------------------------------------------------

export type CallType = "order_confirmation" | "delivery_confirmation";

export interface StartedCallAttempt {
  /** call_attempts.id — a uuid, same as every other primary key in mjunction's schema. */
  id: string;
  attemptNumber: number;
}

/**
 * Open a call_attempts row when the call is placed. `attempt_number` mirrors
 * `nextAttemptNumber` in mjunction's `app/actions/calls.ts`: count existing
 * attempts of this call_type for this recipient, +1.
 */
export async function startCallAttempt(params: {
  recipientId: string;
  callType: CallType;
}): Promise<StartedCallAttempt | null> {
  const client = db();
  if (!client) return null;

  const { count, error: countError } = await client
    .from("call_attempts")
    .select("*", { count: "exact", head: true })
    .eq("recipient_id", params.recipientId)
    .eq("call_type", params.callType);

  if (countError) {
    console.error("[startCallAttempt] count failed:", countError.code, countError.message);
  }
  const attemptNumber = (count ?? 0) + 1;

  const { data, error } = await client
    .from("call_attempts")
    .insert({
      recipient_id: params.recipientId,
      call_type: params.callType,
      attempt_number: attemptNumber,
      provider: "exotel",
      caller_type: "ivr",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[startCallAttempt] insert failed:", error?.code, error?.message);
    return null;
  }

  return { id: data.id as string, attemptNumber };
}

export interface OpenCallAttempt {
  /** call_attempts.id — a uuid. */
  id: string;
  recipientId: string;
  callType: CallType;
  attemptNumber: number;
  /** Null until finalizeCallAttempt has run — callers use this to tell "still open" from "already finalized". */
  outcome: CallOutcome | null;
}

/**
 * Recover the call_attempts row for a call_sid — needed by every step after
 * the one that placed the call, since none of them carry the call_attempts
 * id directly. Resolves through `ivr_logs.call_attempt_id`, stamped there by
 * `startCallAttempt`'s caller via `upsertCallLog`. Despite the name, this can
 * return an already-finalized attempt too (its `outcome` will be non-null) —
 * callers that must not finalize twice (status-callback) check that field.
 */
export async function getOpenCallAttemptByCallSid(
  callSid: string,
): Promise<OpenCallAttempt | null> {
  const client = db();
  if (!client || !callSid) return null;

  const { data: logRow, error: logError } = await client
    .from("ivr_logs")
    .select("call_attempt_id")
    .eq("call_sid", callSid)
    .maybeSingle();

  if (logError) {
    console.error("[getOpenCallAttemptByCallSid] ivr_logs lookup failed:", logError.code, logError.message);
    return null;
  }
  if (!logRow?.call_attempt_id) return null;

  const { data, error } = await client
    .from("call_attempts")
    .select("id, recipient_id, call_type, attempt_number, outcome")
    .eq("id", logRow.call_attempt_id)
    .maybeSingle();

  if (error) {
    console.error("[getOpenCallAttemptByCallSid] call_attempts lookup failed:", error.code, error.message);
    return null;
  }
  if (!data) return null;

  return {
    id: data.id as string,
    recipientId: data.recipient_id as string,
    callType: data.call_type as CallType,
    attemptNumber: data.attempt_number as number,
    outcome: (data.outcome as CallOutcome | null) ?? null,
  };
}

/**
 * How long a still-open call_attempts row (no outcome yet) counts as
 * "genuinely still active" for `hasActiveCallForPhone`. Kept well short of
 * `getStaleOpenCallAttempts`'s 10-minute floor: an IVR call itself only ever
 * runs a couple of minutes, so anything older than this is far more likely a
 * missed StatusCallback (which reconcile-calls cleans up on its own slower
 * schedule) than a call still ringing/connected, and should not go on
 * blocking new calls to the same number indefinitely.
 */
const ACTIVE_CALL_WINDOW_MINUTES = 15;

/**
 * True if `phoneNumber` already has a call in flight — open (no outcome
 * yet), in a non-terminal provider state, started recently enough to still
 * plausibly be ringing or connected. Checked by phone number rather than
 * recipient_id: a phone number can belong to more than one recipient row
 * (import no longer dedupes on phone — see mjunction's commitImport), and
 * Exotel can only ever have one real active call to a given number at a
 * time regardless of which order it's for.
 *
 * Fails open (returns false) on any lookup error or timeout — a DB hiccup
 * must never block a legitimate call, matching this module's posture
 * everywhere else (see `withTimeout`, `resolveOrder` in dynamic-greeting).
 */
export async function hasActiveCallForPhone(phoneNumber: string): Promise<boolean> {
  const client = db();
  if (!client || !phoneNumber) return false;

  return await withTimeout(
    (async () => {
      const { data: recipientRows, error: recError } = await client
        .from("recipients")
        .select("id")
        .eq("contact_no_e164", phoneNumber);

      if (recError) {
        console.error("[hasActiveCallForPhone] recipients lookup failed:", recError.code, recError.message);
        return false;
      }
      const recipientIds = (recipientRows ?? []).map((r) => r.id as string);
      if (!recipientIds.length) return false;

      const cutoff = new Date(Date.now() - ACTIVE_CALL_WINDOW_MINUTES * 60_000)
        .toISOString();

      const { count, error } = await client
        .from("call_attempts")
        .select("id", { count: "exact", head: true })
        .in("recipient_id", recipientIds)
        .is("outcome", null)
        .gt("started_at", cutoff)
        .or(
          "provider_status.is.null,provider_status.eq.queued,provider_status.eq.ringing,provider_status.eq.in-progress",
        );

      if (error) {
        console.error("[hasActiveCallForPhone] call_attempts lookup failed:", error.code, error.message);
        return false;
      }
      return (count ?? 0) > 0;
    })(),
    false,
    "hasActiveCallForPhone",
  );
}

export interface StaleCallAttempt {
  id: string;
  callSid: string;
  recipientId: string;
  callType: CallType;
  attemptNumber: number;
}

/**
 * Calls whose terminal status likely never arrived — the case Exotel's own
 * webhook docs call out ("StatusCallback delivery may be delayed or fail...
 * implement fallback logic using the Call Details API"). `reconcile-calls`
 * polls this list and asks Exotel directly instead of waiting on the
 * webhook.
 *
 * "Likely never arrived" is `outcome is null` (nothing finalized it) AND
 * `provider_status` is still a non-terminal value (or was never set at all)
 * — a call that *did* get a real terminal status via status-callback but
 * stayed outcome-less on purpose (e.g. the caller hung up mid-menu, see
 * `terminalStatusOutcome`) is a legitimate permanent state, not a missed
 * webhook, and re-polling it forever would just waste Exotel API calls.
 *
 * Bounded on both ends of `started_at`: `olderThanMinutes` gives Exotel's own
 * webhook a fair chance to arrive first, `newerThanHours` stops a call from
 * being retried forever if it can never resolve (e.g. Exotel itself lost the
 * record).
 */
export async function getStaleOpenCallAttempts(params: {
  olderThanMinutes: number;
  newerThanHours: number;
  limit?: number;
}): Promise<StaleCallAttempt[]> {
  const client = db();
  if (!client) return [];

  const now = Date.now();
  const olderThan = new Date(now - params.olderThanMinutes * 60_000)
    .toISOString();
  const newerThan = new Date(now - params.newerThanHours * 3_600_000)
    .toISOString();

  const { data, error } = await client
    .from("call_attempts")
    .select("id, recipient_id, call_type, attempt_number")
    .is("outcome", null)
    .lt("started_at", olderThan)
    .gt("started_at", newerThan)
    .or(
      "provider_status.is.null,provider_status.eq.queued,provider_status.eq.ringing,provider_status.eq.in-progress",
    )
    .order("started_at", { ascending: true })
    .limit(params.limit ?? 50);

  if (error) {
    console.error(
      "[getStaleOpenCallAttempts] call_attempts query failed:",
      error.code,
      error.message,
    );
    return [];
  }
  if (!data?.length) return [];

  const ids = data.map((row) => row.id as string);
  const { data: logRows, error: logError } = await client
    .from("ivr_logs")
    .select("call_sid, call_attempt_id")
    .in("call_attempt_id", ids);

  if (logError) {
    console.error(
      "[getStaleOpenCallAttempts] ivr_logs lookup failed:",
      logError.code,
      logError.message,
    );
    return [];
  }

  const callSidByAttemptId = new Map<string, string>();
  for (const row of logRows ?? []) {
    const attemptId = row.call_attempt_id as string | null;
    const callSid = row.call_sid as string | null;
    if (attemptId && callSid) callSidByAttemptId.set(attemptId, callSid);
  }

  const result: StaleCallAttempt[] = [];
  for (const row of data) {
    const callSid = callSidByAttemptId.get(row.id as string);
    // No call_sid on record at all — nothing for the Call Details API to
    // look up yet (ivr-engine writes it synchronously at dial time, so this
    // should only ever be a brief race, not a stuck state).
    if (!callSid) continue;
    result.push({
      id: row.id as string,
      callSid,
      recipientId: row.recipient_id as string,
      callType: row.call_type as CallType,
      attemptNumber: row.attempt_number as number,
    });
  }
  return result;
}

/**
 * Attach Exotel's recording URL (+ CallSid + call duration, when Exotel sent
 * one) to a call_attempts row. Separate from `finalizeCallAttempt` because
 * the recording only becomes known once Exotel's StatusCallback fires —
 * which can be well after the Gather flow already finalized the outcome, or
 * can be the only signal at all for a call that never answered.
 */
/**
 * Persist Exotel's raw telephony status (queued/ringing/completed/no-answer/
 * busy/failed/...) onto a call_attempts row — distinct from the business
 * `outcome` column. Written at dial time (ivr-engine/index.ts, right after
 * startExotelCall) and again at the terminal StatusCallback
 * (status-callback/index.ts), unconditionally — a "completed" status with no
 * recording and no outcome change is still a real status worth showing in
 * mjunction's call log.
 */
export async function updateProviderStatus(
  callAttemptId: string,
  status: string,
): Promise<void> {
  const client = db();
  if (!client || !callAttemptId || !status) return;

  const { error } = await client
    .from("call_attempts")
    .update({ provider_status: status })
    .eq("id", callAttemptId);

  if (error) {
    console.error("[updateProviderStatus] update failed:", error.code, error.message);
  }
}

export async function attachCallRecording(params: {
  callAttemptId: string;
  recipientId: string;
  recordingUrl: string | null;
  providerCallRef: string;
  durationSeconds?: number | null;
}): Promise<void> {
  const client = db();
  if (!client) return;

  const { error } = await client
    .from("call_attempts")
    .update({
      provider_call_ref: params.providerCallRef,
      ...(params.recordingUrl != null
        ? { recording_url: params.recordingUrl }
        : {}),
      ...(params.durationSeconds != null
        ? { duration_seconds: params.durationSeconds }
        : {}),
    })
    .eq("id", params.callAttemptId);

  if (error) {
    console.error("[attachCallRecording] update failed:", error.code, error.message);
    return;
  }

  notifyPortalCallRecordsRefresh(params.recipientId);
}

/**
 * Exotel's terminal call status -> outcome, for a call that never reached a
 * Gather step at all (so there is no digit to derive an outcome from — this
 * is the only signal). `null` for anything that isn't a clean "never
 * connected" — notably `completed`, which just means the call ended, not
 * that it ended *without* a Gather outcome; a call_attempts row with a
 * recording but no outcome is an honest state, not a bug, when the caller
 * hung up mid-menu.
 */
export function terminalStatusOutcome(exotelStatus: string): CallOutcome | null {
  switch (exotelStatus.trim().toLowerCase()) {
    case "no-answer":
    case "no_answer":
      return "no_answer";
    case "busy":
    case "failed":
    case "canceled":
    case "cancelled":
      return "not_reachable";
    default:
      return null;
  }
}

/** Append a row to the recipient's timeline — same shape as mjunction's own `logEvent`. */
export async function logRecipientEvent(params: {
  recipientId: string;
  eventType: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const client = db();
  if (!client) return;

  const { error } = await client.from("recipient_events").insert({
    recipient_id: params.recipientId,
    event_type: params.eventType,
    actor_type: "ivr",
    payload: params.payload ?? {},
  });

  if (error) {
    console.error("[logRecipientEvent] failed:", error.code, error.message);
  }
}

/**
 * Validate + apply a status transition — the Deno-side equivalent of
 * mjunction's `transitionStatus` (src/lib/domain/audit.ts). Differs in one
 * way on purpose: this is always fire-and-forget server-to-server code with
 * no one watching for a thrown error, so an illegal transition is logged and
 * skipped rather than thrown, matching this repo's existing "never let a
 * write error take down the call" posture.
 */
export async function transitionRecipientStatus(params: {
  recipientId: string;
  from: RecipientStatus;
  to: RecipientStatus;
  payload?: Record<string, unknown>;
}): Promise<void> {
  if (params.from === params.to) return;
  if (!canTransition(params.from, params.to)) {
    console.warn(
      `[transitionRecipientStatus] illegal transition ${params.from} -> ${params.to} for recipient ${params.recipientId}; skipped`,
    );
    return;
  }

  const client = db();
  if (!client) return;

  const { error } = await client
    .from("recipients")
    .update({ status: params.to, updated_at: new Date().toISOString() })
    .eq("id", params.recipientId);

  if (error) {
    console.error("[transitionRecipientStatus] update failed:", error.code, error.message);
    return;
  }

  await logRecipientEvent({
    recipientId: params.recipientId,
    eventType: "status_change",
    payload: { from: params.from, to: params.to, ...(params.payload ?? {}) },
  });
}

export interface FinalizeCallAttemptParams {
  callAttemptId: string;
  recipientId: string;
  from: RecipientStatus;
  callType: CallType;
  attemptNumber: number;
  outcome: CallOutcome;
  dtmfResponse?: string | null;
}

/**
 * Close out a call_attempts row and apply its consequences: a `call_attempt`
 * timeline event (always) and, for order-confirmation calls, the resulting
 * recipient status transition (per `orderConfirmationStatusFor` — a reported
 * address issue or an agent transfer deliberately leaves the recipient at
 * `order_confirm_pending`; only a clean confirm or a fully-unreachable call
 * advances it). Called once the call's outcome is known, whether that is
 * because the caller finished the Gather flow or because Exotel's
 * StatusCallback reported the call never connected.
 */
export async function finalizeCallAttempt(
  params: FinalizeCallAttemptParams,
): Promise<void> {
  const client = db();
  if (!client) return;

  const { error } = await client
    .from("call_attempts")
    .update({
      outcome: params.outcome,
      dtmf_response: params.dtmfResponse ?? null,
      ended_at: new Date().toISOString(),
    })
    .eq("id", params.callAttemptId);

  if (error) {
    console.error("[finalizeCallAttempt] update failed:", error.code, error.message);
  }

  await logRecipientEvent({
    recipientId: params.recipientId,
    eventType: "call_attempt",
    payload: {
      call_type: params.callType,
      attempt_number: params.attemptNumber,
      dtmf: params.dtmfResponse ?? null,
      outcome: params.outcome,
      caller_type: "ivr",
    },
  });

  const to = params.callType === "delivery_confirmation"
    ? deliveryConfirmationStatusFor(params.outcome, params.from)
    : orderConfirmationStatusFor(params.outcome, params.from);

  if (to !== params.from) {
    await transitionRecipientStatus({
      recipientId: params.recipientId,
      from: params.from,
      to,
      payload: { via: params.callType, outcome: params.outcome },
    });
  }

  // A confirmed delivery is what seals a VOC. Attempted here as well as from
  // status-callback because the two signals arrive in an order this function
  // cannot predict — the outcome usually lands first (the caller finished the
  // menu) but the recording only exists once Exotel's terminal callback
  // fires. sealDeliveryVoc is idempotent, so whichever arrives second is the
  // one that actually seals.
  if (params.callType === "delivery_confirmation" && params.outcome === "confirmed") {
    await sealDeliveryVoc(params.callAttemptId);
  }

  notifyPortalCallRecordsRefresh(params.recipientId);
}

/**
 * Human-facing sealed VOC id. Same format the admin panel's own mock path
 * mints (`sealedVocId` in mjunction's src/lib/domain/call-flow.ts) so a real
 * and a mock recording are indistinguishable in the vault and in the client
 * report.
 */
function sealedVocId(): string {
  const now = new Date();
  const stamp = now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, "0") +
    String(now.getUTCDate()).padStart(2, "0");
  const rand = Math.floor(Math.random() * 1e6).toString(36).toUpperCase().padStart(4, "0");
  return `VOC-${stamp}-${rand}`;
}

/**
 * Seal the VOC for a confirmed delivery-confirmation call, if it is ready to
 * be sealed and has not been already.
 *
 * "Ready" means the call_attempts row has both a `confirmed` outcome and a
 * `recording_url` — a sealed VOC with nothing to play back would be a lie in
 * the client report. Called from both sides of that race (finalizeCallAttempt
 * and status-callback) and safe to run repeatedly: it returns early if a
 * voc_recordings row already exists for this attempt.
 *
 * `storage_path` holds Exotel's own recording URL rather than a Supabase
 * Storage object key. The column is `not null` and this audio genuinely lives
 * outside the `voc` bucket — it is never uploaded — so mjunction's
 * `getSignedVocUrl` hands an absolute URL straight back instead of trying to
 * sign it.
 */
export async function sealDeliveryVoc(callAttemptId: string): Promise<void> {
  const client = db();
  if (!client || !callAttemptId) return;

  const { data: existing, error: existingError } = await client
    .from("voc_recordings")
    .select("id")
    .eq("call_attempt_id", callAttemptId)
    .maybeSingle();

  if (existingError) {
    console.error("[sealDeliveryVoc] existing lookup failed:", existingError.code, existingError.message);
    return;
  }
  if (existing) return;

  const { data: attempt, error: attemptError } = await client
    .from("call_attempts")
    .select("id, recipient_id, call_type, outcome, language, dtmf_response, recording_url, duration_seconds")
    .eq("id", callAttemptId)
    .maybeSingle();

  if (attemptError) {
    console.error("[sealDeliveryVoc] attempt lookup failed:", attemptError.code, attemptError.message);
    return;
  }
  // Not an error — this is the normal "the other half hasn't arrived yet" case.
  if (!attempt || attempt.call_type !== "delivery_confirmation") return;
  if (attempt.outcome !== "confirmed" || !attempt.recording_url) return;

  const { data: recipient } = await client
    .from("recipients")
    .select("product_name")
    .eq("id", attempt.recipient_id)
    .maybeSingle();

  const sealed = sealedVocId();
  const { error } = await client.from("voc_recordings").insert({
    sealed_voc_id: sealed,
    recipient_id: attempt.recipient_id,
    call_attempt_id: attempt.id,
    call_type: "delivery_confirmation",
    product_name: recipient?.product_name ?? null,
    caller_type: "ivr",
    language: attempt.language,
    dtmf_outcome: attempt.dtmf_response,
    storage_path: attempt.recording_url,
    duration_seconds: attempt.duration_seconds,
  });

  if (error) {
    console.error("[sealDeliveryVoc] insert failed:", error.code, error.message);
    return;
  }

  await logRecipientEvent({
    recipientId: attempt.recipient_id as string,
    eventType: "voc_sealed",
    payload: { sealed_voc_id: sealed, language: attempt.language },
  });
}

/**
 * Fire-and-forget notification to mjunction's telephony webhook so it can
 * refresh the derived `call_records` rollup (VOC/Reports) for this
 * recipient — mirrors `notifyOrderStatusUpdate`'s pattern, but crosses into
 * the sibling mjunction repo instead of staying within this project's own
 * functions. A missing `PORTAL_WEBHOOK_URL`/`IVR_SHARED_SECRET` degrades to
 * a no-op (call_records simply stays stale) rather than failing the call.
 */
export function notifyPortalCallRecordsRefresh(recipientId: string): void {
  const portalWebhookUrl = Deno.env.get("PORTAL_WEBHOOK_URL");
  const secret = Deno.env.get("IVR_SHARED_SECRET");
  if (!portalWebhookUrl || !secret) return;

  const task = fetch(portalWebhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ivr-shared-secret": secret,
    },
    body: JSON.stringify({ recipientId }),
  })
    .then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(
          `[notifyPortalCallRecordsRefresh] portal webhook returned ${res.status}: ${text}`,
        );
      }
    })
    .catch((err) => {
      console.error("[notifyPortalCallRecordsRefresh] request failed:", err);
    });

  waitUntil(task);
}

// ---------------------------------------------------------------------------
// Cross-function notification — written by `update-order-status`, triggered
// by `dynamic-greeting` when the Gather flow finishes.
//
// dynamic-greeting knows which call_sid this is, which branch of the menu
// Exotel routed to, and therefore both the outcome and the digit that
// produced it — but it is not allowed to write to `recipients` /
// `call_attempts` itself, and must not add a blocking DB write to its own
// response: every millisecond there counts against Exotel's 5s abandon
// timer. So the write happens inside `update-order-status` instead, which
// runs after the Exotel response has already gone out. That keeps the two
// responsibilities (IVR flow vs. state mutation) independent and
// redeployable on their own, same as before.
// ---------------------------------------------------------------------------

export interface OrderStatusNotification {
  orderId: string;
  callSid: string;
  callerNumber?: string;
  /**
   * The digit the caller pressed on the menu. `dynamic-greeting` sends it on
   * every terminal step (derived from the branch Exotel routed to, since
   * Exotel does not echo the digit into that request), so a real call now
   * lands a `call_attempts.dtmf_response` instead of the null it used to.
   */
  dtmf?: string;
  /**
   * Explicit outcome, for triggers that are not a keypress — e.g. a support
   * transfer marking the call `transferred_to_agent`. Wins over `dtmf` when
   * both are present.
   */
  outcome?: CallOutcome;
}

/**
 * Fire-and-forget call from `dynamic-greeting` to the
 * `update-order-status` function. Uses `EdgeRuntime.waitUntil` so the HTTP
 * call can finish after the Exotel response has already gone out, without
 * delaying it and without the isolate being torn down early.
 *
 * The target URL is derived from `SUPABASE_URL` (already required by this
 * module) rather than a separate env var, so there is one less secret to
 * keep in sync across environments. Both functions run with
 * `verify_jwt = false`, so no Authorization header is strictly required;
 * the service-role key is still attached as a bearer token as defense in
 * depth in case JWT verification is ever turned back on.
 */
export function notifyOrderStatusUpdate(entry: OrderStatusNotification): void {
  // Nothing to resolve into an outcome — never fire an empty notification.
  if (!entry.outcome && !entry.dtmf) return;

  const targetUrl = functionsUrl("update-order-status");

  const task = fetch(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(serviceRoleKey() ? { Authorization: `Bearer ${serviceRoleKey()}` } : {}),
    },
    body: JSON.stringify(entry),
  })
    .then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(
          `[notifyOrderStatusUpdate] update-order-status returned ${res.status}: ${text}`,
        );
      }
    })
    .catch((err) => {
      console.error("[notifyOrderStatusUpdate] request failed:", err);
    });

  waitUntil(task);
}
