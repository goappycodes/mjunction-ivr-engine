/**
 * Support-transfer configuration resolver.
 *
 * This module is the single source of truth for *what* to dial and *how* when a
 * caller asks to be connected to a real person. It deliberately knows nothing
 * about Exotel's wire format — `../_shared/connect.ts` owns that mapping — so
 * the two can be changed independently.
 *
 * ---------------------------------------------------------------------------
 * SWAP POINT (env -> database)
 * ---------------------------------------------------------------------------
 * Today the config is read from environment variables (a hardcoded support
 * number for the whole account). To make it per-order / per-queue later, replace
 * the body of `resolveConnectConfig` with a database lookup keyed off
 * `ctx.orderId` (or a support-routing table) — see `connect-telecaller/config.ts`
 * for exactly that pattern, applied to the address-issue transfer. Nothing else
 * has to change:
 *   - the return type `ConnectConfig` is the stable contract every caller uses,
 *   - `index.ts` never reads env directly.
 * Keep the env values as the fallback so a missing/empty row degrades to the
 * account-wide default instead of a failed transfer.
 */
import {
  type ConnectConfig as BaseConnectConfig,
  MAX_CONVERSATION_CAP,
  MAX_RINGING_CAP,
  parseBool,
  parseIntClamped,
  toE164,
} from "../_shared/connect.ts";

export { toE164 };

/** Support-connect config: the wire-format base plus the order-status side effect. */
export interface ConnectConfig extends BaseConnectConfig {
  /**
   * Call outcome to record when the caller is transferred to support — one of
   * the `call_attempts.outcome` values (default `transferred_to_agent`, which
   * is what the escalations queue's order-type filter looks for). Written via
   * update-order-status (never a direct DB write from here). Empty disables
   * the update.
   */
  orderStatus: string;
}

/** What the caller knows about the current call. Passed by `index.ts` from the Exotel applet parameters. */
export interface ConnectContext {
  orderId?: string;
  callSid?: string;
  callerNumber?: string;
}

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
  // Matches the outcome the order-confirmation script itself would record for
  // a "press 2" escalation (see resolveOrderConfirmationOutcome), and the
  // value the escalations queue's order-type filter queries for.
  orderStatus: "transferred_to_agent",
};

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
