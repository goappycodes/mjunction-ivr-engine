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

// ---------------------------------------------------------------------------
// Order status updates — written by `update-order-status`, triggered by
// `dynamic-greeting`.
//
// dynamic-greeting resolves the order and plays prompts but is not allowed to
// write to `orders` itself; a separate function owns that write so the two
// responsibilities (IVR flow vs. state mutation) stay independent and can be
// redeployed/audited separately.
// ---------------------------------------------------------------------------

/** Only these two DTMF values represent a final decision worth persisting. */
export const DTMF_STATUS_MAP: Record<string, string> = {
  "1": "confirmed",
  "2": "support_requested",
};

export interface OrderStatusUpdateResult {
  success: boolean;
  error?: string;
}

/**
 * Direct DB write, used inside the `update-order-status` function itself.
 * Distinguishes "no such order" from "the query failed" in the log, but both
 * collapse to `success: false` for the caller — Exotel only needs to know
 * whether to move on, not why.
 */
export async function updateOrderStatus(
  orderId: string,
  status: string,
): Promise<OrderStatusUpdateResult> {
  const client = db();
  if (!client) {
    return { success: false, error: "No Supabase key configured" };
  }

  const { data, error } = await client
    .from("orders")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("order_id", orderId)
    .select("order_id")
    .maybeSingle();

  if (error) {
    console.error("[updateOrderStatus] failed:", error.code, error.message);
    return { success: false, error: `${error.code}: ${error.message}` };
  }

  if (!data) {
    console.warn(`[updateOrderStatus] no order matched order_id="${orderId}"`);
    return { success: false, error: `Order not found: ${orderId}` };
  }

  return { success: true };
}

export interface OrderStatusNotification {
  orderId: string;
  callSid: string;
  callerNumber?: string;
  /** DTMF path: a keypress mapped to a status via `DTMF_STATUS_MAP`. */
  dtmf?: string;
  /**
   * Explicit status, for triggers that are not a keypress — e.g. a support
   * transfer marking the order `issue_raised`. Wins over `dtmf` when both are
   * present.
   */
  status?: string;
}

/**
 * Fire-and-forget call from `dynamic-greeting` to the `update-order-status`
 * function. Uses the same `EdgeRuntime.waitUntil` pattern as `logCallStep`
 * so the HTTP call can finish after the Exotel response has already gone
 * out, without delaying it and without the isolate being torn down early.
 *
 * The target URL is derived from `SUPABASE_URL` (already required by this
 * module) rather than a separate env var, so there is one less secret to
 * keep in sync across environments. Both functions run with
 * `verify_jwt = false`, so no Authorization header is strictly required;
 * the service-role key is still attached as a bearer token as defense in
 * depth in case JWT verification is ever turned back on.
 */
export function notifyOrderStatusUpdate(entry: OrderStatusNotification): void {
  // Resolve the target status here so a call that has nothing to persist is
  // never fired. An explicit status wins; otherwise the DTMF digit must map to
  // one ("1"/"2"). Anything else is a no-op.
  const status = entry.status?.trim() || DTMF_STATUS_MAP[entry.dtmf ?? ""];
  if (!status) {
    return;
  }

  const targetUrl = `${supabaseUrl.replace(/\/$/, "")}/functions/v1/update-order-status`;

  const task = fetch(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(supabaseKey ? { Authorization: `Bearer ${supabaseKey}` } : {}),
    },
    // Send the resolved status explicitly so the receiver does not have to
    // re-derive it from the digit.
    body: JSON.stringify({ ...entry, status }),
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

  const runtime = (globalThis as {
    EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
  }).EdgeRuntime;

  if (runtime?.waitUntil) runtime.waitUntil(task);
}
