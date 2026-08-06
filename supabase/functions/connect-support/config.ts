/**
 * Support-transfer configuration resolver.
 *
 * This module is the single source of truth for *what* to dial and *how* when a
 * caller asks to be connected to a real person. It deliberately knows nothing
 * about Exotel's wire format — `exotel.ts` owns that mapping — so the two can be
 * changed independently.
 *
 * ---------------------------------------------------------------------------
 * SWAP POINT (env -> database)
 * ---------------------------------------------------------------------------
 * Today the config is read from environment variables (a hardcoded support
 * number for the whole account). To make it per-order / per-queue later, replace
 * the body of `resolveConnectConfig` with a database lookup keyed off
 * `ctx.orderId` (or a support-routing table). Nothing else has to change:
 *   - the return type `ConnectConfig` is the stable contract every caller uses,
 *   - `index.ts` and `exotel.ts` never read env directly.
 * Keep the env values as the fallback so a missing/empty row degrades to the
 * account-wide default instead of a failed transfer.
 */

/** Domain-level connect settings, independent of any telephony provider. */
export interface ConnectConfig {
  /** Numbers to dial, in E.164, tried in order until one answers. */
  numbers: string[];
  /** Number shown to the agent as the caller id; defaults to the Exotel caller id. */
  outgoingPhoneNumber?: string;
  record: boolean;
  recordingChannels: "single" | "dual";
  /** Seconds to ring each destination. Exotel caps this at 60. */
  maxRingingDuration: number;
  /** Seconds the connected conversation may last. Exotel caps this at 4500. */
  maxConversationDuration: number;
  musicOnHoldType: "default_tone" | "operator_tone" | "custom_tone";
  /** Spoken to the caller while the agent's phone is ringing. Empty = silent. */
  waitMessage: string;
  /** When true, Exotel re-fetches this URL after a failed attempt (for rotation). */
  fetchAfterAttempt: boolean;
  /**
   * Order status to persist when the caller is transferred to support. Written
   * via update-order-status (never a direct DB write from here). Empty disables
   * the status update.
   */
  orderStatus: string;
}

/**
 * What the caller knows about the current call. A future DB-backed resolver uses
 * this to route (e.g. VIP orders to a priority queue); the env resolver ignores
 * it. Passed by `index.ts` from the Exotel applet parameters.
 */
export interface ConnectContext {
  orderId?: string;
  callSid?: string;
  callerNumber?: string;
}

// Exotel's documented hard limits — used to clamp whatever config we resolve so
// a bad env value can never produce a response Exotel rejects.
const MAX_RINGING_CAP = 60;
const MAX_CONVERSATION_CAP = 4500;

const DEFAULTS = {
  countryCode: "91",
  // Off by default. Sending "record": true to an Exotel account that doesn't
  // have call recording enabled can make Exotel reject the whole Connect
  // response, dropping the call. Opt in via SUPPORT_RECORD=true only once call
  // recording is confirmed enabled on the account.
  record: false,
  // Exotel's own documented default is "single" — not every account/plan is
  // guaranteed to support dual-channel recording. Only relevant once
  // SUPPORT_RECORD is enabled; kept at Exotel's default so turning recording on
  // later doesn't also require remembering to set this.
  recordingChannels: "single" as const,
  maxRingingDuration: 30,
  maxConversationDuration: 900,
  musicOnHoldType: "default_tone" as const,
  // Off by default. start_call_playback is an easy way to make Exotel reject the
  // whole Connect response (its playback_to enum is narrow — the docs only show
  // "both"/"callee"), which drops the call. Opt in via SUPPORT_WAIT_MESSAGE once
  // the basic transfer is confirmed working.
  waitMessage: "",
  orderStatus: "issue_raised",
};

/**
 * Normalise a phone number to E.164 (`+<cc><national>`), which is the only form
 * Exotel's Connect destination accepts reliably. Accepts a raw 10-digit number
 * (`7872944208`), a country-coded one (`917872944208`), or an already-formatted
 * `+91...`; strips spaces, hyphens and brackets from any of them.
 */
export function toE164(raw: string, countryCode = DEFAULTS.countryCode): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("+")) {
    return `+${trimmed.slice(1).replace(/\D/g, "")}`;
  }

  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";

  // Longer than a national number means the country code is already baked in;
  // keep the trailing 10 digits and re-prefix the configured code either way.
  const national = digits.length > 10 ? digits.slice(-10) : digits;
  return `+${countryCode}${national}`;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function parseIntClamped(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number.parseInt((value ?? "").trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function env(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v.trim() ? v : undefined;
}

/**
 * Resolve the connect configuration for this call.
 *
 * Env-backed for now (see SWAP POINT above). `SUPPORT_NUMBERS` (comma-separated)
 * takes precedence over the single `SUPPORT_NUMBER`, so an operator can list a
 * hunt group without a code change.
 */
// deno-lint-ignore require-await
export async function resolveConnectConfig(
  _ctx: ConnectContext,
): Promise<ConnectConfig> {
  const countryCode = env("SUPPORT_COUNTRY_CODE") ?? DEFAULTS.countryCode;

  const raw = env("SUPPORT_NUMBERS") ?? env("SUPPORT_NUMBER") ?? "";
  const numbers = raw
    .split(",")
    .map((n) => toE164(n, countryCode))
    .filter(Boolean);

  const channels = (env("SUPPORT_RECORDING_CHANNELS") ??
    DEFAULTS.recordingChannels).toLowerCase() === "single"
    ? "single"
    : "dual";

  const moh = env("SUPPORT_MUSIC_ON_HOLD_TYPE")?.toLowerCase();
  const musicOnHoldType = moh === "operator_tone" || moh === "custom_tone"
    ? moh
    : DEFAULTS.musicOnHoldType;

  // Only set outgoing_phone_number when it is explicitly configured AND a valid
  // E.164 ExoPhone. Exotel requires E.164 here; the old default of EXOTEL_CALLER_ID
  // ("02249360074", not E.164) made Exotel reject the Connect response and drop
  // the call. Omitting it makes Exotel dial the agent from the same ExoPhone as
  // the first leg, which is exactly what we want.
  const outgoingRaw = env("SUPPORT_OUTGOING_PHONE_NUMBER");
  const outgoingPhoneNumber = outgoingRaw
    ? toE164(outgoingRaw, countryCode)
    : undefined;

  return {
    numbers,
    outgoingPhoneNumber,
    record: parseBool(env("SUPPORT_RECORD"), DEFAULTS.record),
    recordingChannels: channels,
    maxRingingDuration: parseIntClamped(
      env("SUPPORT_MAX_RINGING_DURATION"),
      DEFAULTS.maxRingingDuration,
      1,
      MAX_RINGING_CAP,
    ),
    maxConversationDuration: parseIntClamped(
      env("SUPPORT_MAX_CONVERSATION_DURATION"),
      DEFAULTS.maxConversationDuration,
      1,
      MAX_CONVERSATION_CAP,
    ),
    musicOnHoldType,
    waitMessage: Deno.env.get("SUPPORT_WAIT_MESSAGE") ?? DEFAULTS.waitMessage,
    fetchAfterAttempt: parseBool(env("SUPPORT_FETCH_AFTER_ATTEMPT"), false),
    // Deno.env.get (not env()) so an operator can set it empty to disable the update.
    orderStatus: Deno.env.get("SUPPORT_CONNECT_STATUS") ?? DEFAULTS.orderStatus,
  };
}
