/**
 * Shared data access for the IVR functions.
 *
 * Both `ivr-engine` (call initiation) and `dynamic-greeting` (prompt
 * construction) need the same order lookups and the same call-log table, so the
 * client and queries live here rather than being duplicated.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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

/** Primary path: the order id travelled with the call via Exotel CustomField. */
export async function getOrderById(orderId: string): Promise<OrderRecord | null> {
  const client = db();
  if (!client) return null;

  const { data, error } = await client
    .from("orders")
    .select(ORDER_COLUMNS)
    .eq("order_id", orderId)
    .maybeSingle();

  if (error) {
    console.error("[getOrderById] failed:", error.code, error.message);
    return null;
  }
  return (data as OrderRecord | null) ?? null;
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

  const { error } = await client
    .from("ivr_logs")
    .upsert(row, { onConflict: "call_sid" });

  if (error) {
    console.error("[upsertCallLog] failed:", error.code, error.message);
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
