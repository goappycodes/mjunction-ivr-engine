/**
 * Supabase client + small runtime helpers shared by every function —
 * factored out of `orders.ts` so that a lightweight consumer (logging.ts)
 * doesn't have to pull in the whole recipient/call_attempts business-logic
 * module just to get a DB handle.
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

/** Build a same-project functions URL, e.g. for a default StatusCallback. */
export function functionsUrl(name: string): string {
  return `${supabaseUrl.replace(/\/$/, "")}/functions/v1/${name}`;
}

/** The same key `db()` authenticates with — for callers that need it as a bearer token rather than a Supabase client. */
export function serviceRoleKey(): string {
  return supabaseKey;
}

/**
 * Fire-and-forget helper: keeps the worker alive until `task` finishes,
 * which a bare un-awaited promise does not guarantee once the response has
 * already gone out.
 */
export function waitUntil(task: Promise<unknown>): void {
  const runtime = (globalThis as {
    EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
  }).EdgeRuntime;

  if (runtime?.waitUntil) runtime.waitUntil(task);
}
