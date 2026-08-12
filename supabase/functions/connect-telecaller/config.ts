/**
 * Per-order telecaller-transfer configuration resolver.
 *
 * Same role as `connect-support/config.ts` but resolves the destination
 * number from the order's own `recipients.telecaller_phone` (imported per
 * row alongside `telecaller_name` — see mjunction's import.ts) instead of a
 * single account-wide env var. Falls back to `SUPPORT_NUMBER`/`SUPPORT_NUMBERS`
 * (the same env fallback connect-support uses) when the order has no
 * telecaller phone on file, so a data gap degrades to "reaches someone"
 * rather than "drops the call".
 */
import { getOrderById } from "../_shared/orders.ts";
import {
  type ConnectConfig,
  MAX_CONVERSATION_CAP,
  MAX_RINGING_CAP,
  parseBool,
  parseIntClamped,
  toE164,
} from "../_shared/connect.ts";

export type { ConnectConfig };

export interface ConnectContext {
  orderId?: string;
  callSid?: string;
  callerNumber?: string;
}

const DEFAULTS = {
  countryCode: "91",
  record: false,
  recordingChannels: "single" as const,
  maxRingingDuration: 30,
  maxConversationDuration: 900,
  musicOnHoldType: "default_tone" as const,
  waitMessage: "",
};

function env(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v.trim() ? v : undefined;
}

function fallbackNumbers(countryCode: string): string[] {
  const raw = env("SUPPORT_NUMBERS") ?? env("SUPPORT_NUMBER") ?? "";
  return raw
    .split(",")
    .map((n) => toE164(n, countryCode))
    .filter(Boolean);
}

/**
 * Resolve who to dial for this order's address-issue transfer: the assigned
 * telecaller's phone if one is on file, else the account-wide support
 * fallback. Shares the `TELECALLER_*` env prefix for the call-quality knobs
 * so the two Connect endpoints can be tuned independently.
 */
export async function resolveConnectConfig(
  ctx: ConnectContext,
): Promise<ConnectConfig> {
  const countryCode = env("TELECALLER_COUNTRY_CODE") ?? DEFAULTS.countryCode;

  const order = ctx.orderId ? await getOrderById(ctx.orderId) : null;
  const telecallerNumber = order?.telecaller_phone
    ? toE164(order.telecaller_phone, countryCode)
    : "";

  const numbers = telecallerNumber
    ? [telecallerNumber]
    : fallbackNumbers(countryCode);

  const channels = (env("TELECALLER_RECORDING_CHANNELS") ??
    DEFAULTS.recordingChannels).toLowerCase() === "single"
    ? "single"
    : "dual";

  const moh = env("TELECALLER_MUSIC_ON_HOLD_TYPE")?.toLowerCase();
  const musicOnHoldType = moh === "operator_tone" || moh === "custom_tone"
    ? moh
    : DEFAULTS.musicOnHoldType;

  const outgoingRaw = env("TELECALLER_OUTGOING_PHONE_NUMBER");
  const outgoingPhoneNumber = outgoingRaw
    ? toE164(outgoingRaw, countryCode)
    : undefined;

  return {
    numbers,
    outgoingPhoneNumber,
    record: parseBool(env("TELECALLER_RECORD"), DEFAULTS.record),
    recordingChannels: channels,
    maxRingingDuration: parseIntClamped(
      env("TELECALLER_MAX_RINGING_DURATION"),
      DEFAULTS.maxRingingDuration,
      1,
      MAX_RINGING_CAP,
    ),
    maxConversationDuration: parseIntClamped(
      env("TELECALLER_MAX_CONVERSATION_DURATION"),
      DEFAULTS.maxConversationDuration,
      1,
      MAX_CONVERSATION_CAP,
    ),
    musicOnHoldType,
    waitMessage: Deno.env.get("TELECALLER_WAIT_MESSAGE") ?? DEFAULTS.waitMessage,
    fetchAfterAttempt: parseBool(env("TELECALLER_FETCH_AFTER_ATTEMPT"), false),
  };
}
