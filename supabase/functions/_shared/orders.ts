/**
 * Shared data access for the IVR functions.
 *
 * Both `ivr-engine` (call initiation) and `dynamic-greeting` (prompt
 * construction) need the same order lookups and the same call-log table, so the
 * client and queries live here rather than being duplicated.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isTerminalCallStatus, normalizeCallStatus } from "./callState.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
// Server-to-server: no end-user session exists, so use the service-role key.
// The anon key is subject to RLS and every read here would return zero rows.
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_ANON_KEY") ?? "";

// createClient throws on an empty key. At module scope that would stop the
// worker from booting, so it is built lazily and a missing key degrades to
// "no database" rather than a dropped call.
let cached: SupabaseClient | null = null;
export function db(): SupabaseClient | null {
  if (!supabaseKey) return null;
  if (!cached) cached = createClient(supabaseUrl, supabaseKey);
  return cached;
}

export interface OrderRecord {
  order_id: string;
  phone_number: string;
  customer_name: string | null;
  delivery_address: string | null;
  product_name: string | null;
  status: string | null;
}

const ORDER_COLUMNS =
  "order_id, phone_number, customer_name, delivery_address, product_name, status";

/**
 * Exotel abandons an application URL that has not answered within 5 seconds and
 * drops the caller. Every database path is capped well short of that.
 */
export const DB_TIMEOUT_MS = 1500;

export async function withTimeout<T>(
  work: Promise<T>,
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
 * Look up an order, keeping "does not exist" distinguishable from "the query
 * failed". Callers that must report the real fault (ivr-engine) use this;
 * callers that must never drop a live call (dynamic-greeting) use
 * `getOrderById`, which collapses both cases to null on purpose.
 */
export async function lookupOrderById(orderId: string): Promise<OrderLookup> {
  const client = db();
  if (!client) {
    return { order: null, error: "No Supabase key configured" };
  }

  const { data, error } = await client
    .from("orders")
    .select(ORDER_COLUMNS)
    .eq("order_id", orderId)
    .maybeSingle();

  if (error) {
    console.error("[lookupOrderById] failed:", error.code, error.message);
    return { order: null, error: `${error.code}: ${error.message}` };
  }

  return { order: (data as OrderRecord | null) ?? null, error: null };
}

/** Primary path: the order id travelled with the call via Exotel CustomField. */
export async function getOrderById(orderId: string): Promise<OrderRecord | null> {
  const { order } = await lookupOrderById(orderId);
  return order;
}

/**
 * Inbound-call path: no CustomField exists, so fall back to the caller's number.
 * Callers arrive as `08116411177`, `8116411177` or `+918116411177` depending on
 * the circuit, so match on the last 10 digits.
 */
export async function getOrderByPhone(phone: string): Promise<OrderRecord | null> {
  const client = db();
  if (!client) return null;

  const national = phone.replace(/\D/g, "").slice(-10);
  if (!national) return null;

  const { data, error } = await client
    .from("orders")
    .select(ORDER_COLUMNS)
    // PostgREST uses `*` as the LIKE wildcard in filter strings, not `%`.
    .or(`phone_number.eq.${phone},phone_number.like.*${national}`)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[getOrderByPhone] failed:", error.code, error.message);
    return null;
  }
  return (data as OrderRecord | null) ?? null;
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

export interface CallLogEntry {
  callSid: string;
  callerNumber?: string;
  orderId?: string;
  step: string;
  userInput?: string;
  status: string;
  /** Which applet Exotel appears to have called from; recorded for diagnosis. */
  appletHint?: string;
  /** Exotel's telephony-level Call.Status (`queued`, `in-progress`, ...), distinct from `status` above. */
  callStatus?: string;
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
  // Never overwrite a known caller/order with undefined on a later step.
  if (entry.callerNumber) row.caller_number = entry.callerNumber;
  if (entry.orderId) row.order_id = entry.orderId;
  if (entry.callStatus) row.call_status = entry.callStatus;

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

  const runtime = (globalThis as {
    EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
  }).EdgeRuntime;

  if (runtime?.waitUntil) runtime.waitUntil(task);
}

export interface StatusCallbackEntry {
  callSid: string;
  /** Raw `Status`/`CallStatus` value as Exotel sent it. */
  status: string;
  eventType?: string;
  /** Every param Exotel sent, verbatim, for the append-only audit trail. */
  raw: Record<string, string>;
}

/**
 * Records an Exotel StatusCallback: updates the call's telephony outcome on
 * `ivr_logs` (leaving the conversational `status`/`step` columns untouched —
 * those belong to `dynamic-greeting`) and appends the raw event to
 * `ivr_status_events` unconditionally, so a status Exotel sends that we don't
 * yet recognise is still captured rather than silently dropped.
 */
export async function recordStatusCallback(
  entry: StatusCallbackEntry,
): Promise<void> {
  const client = db();
  if (!client || !entry.callSid) return;

  const normalized = normalizeCallStatus(entry.status);

  const update: Record<string, unknown> = {
    call_status: normalized ?? entry.status,
    updated_at: new Date().toISOString(),
  };
  if (isTerminalCallStatus(entry.status)) {
    update.ended_at = new Date().toISOString();
  }

  const { error } = await client
    .from("ivr_logs")
    .update(update)
    .eq("call_sid", entry.callSid);

  if (error) {
    console.error(
      "[recordStatusCallback] ivr_logs update failed:",
      error.code,
      error.message,
    );
  }

  const { error: eventError } = await client.from("ivr_status_events").insert({
    call_sid: entry.callSid,
    status: entry.status,
    event_type: entry.eventType ?? null,
    raw: entry.raw,
  });

  if (eventError) {
    console.error(
      "[recordStatusCallback] event insert failed:",
      eventError.code,
      eventError.message,
    );
  }
}
