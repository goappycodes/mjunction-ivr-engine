/**
 * Shared helpers for Exotel "Connect Applet — Dynamic URL" endpoints
 * (connect-support, connect-telecaller). Both resolve a destination number a
 * different way, but need the exact same wire format and safety clamps —
 * kept here once so a fix (e.g. a newly-documented field, a tighter cap)
 * lands in every Connect endpoint at the same time.
 *
 * Documented fields (https://support.exotel.com/support/solutions/articles/
 * 3000096873):
 *   destination.numbers        array   REQUIRED  E.164, dialled in order
 *   fetch_after_attempt        bool    optional  default false
 *   outgoing_phone_number      string  optional  caller id shown to the agent
 *   record                     bool    optional  default false
 *   recording_channels         string  optional  "single" | "dual"
 *   max_ringing_duration       int     optional  seconds, max 60,  default 30
 *   max_conversation_duration  int     optional  seconds, max 4500, default 900
 *   music_on_hold.type         string  optional  default_tone | operator_tone | custom_tone
 *   start_call_playback        object  optional  message played as the bridge starts
 */

// Exotel's documented hard limits — used to clamp whatever config a resolver
// produces so a bad env/DB value can never produce a response Exotel rejects.
export const MAX_RINGING_CAP = 60;
export const MAX_CONVERSATION_CAP = 4500;

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
  /** Spoken to the caller while the destination's phone is ringing. Empty = silent. */
  waitMessage: string;
  /** When true, Exotel re-fetches this URL after a failed attempt (for rotation). */
  fetchAfterAttempt: boolean;
}

export interface ExotelConnectResponse {
  destination: { numbers: string[] };
  fetch_after_attempt: boolean;
  record: boolean;
  recording_channels: "single" | "dual";
  max_ringing_duration: number;
  max_conversation_duration: number;
  music_on_hold: { type: string };
  outgoing_phone_number?: string;
  start_call_playback?: {
    // Exotel's documented values are "both" and "callee". "caller" is NOT
    // documented and made Exotel reject the whole Connect response.
    playback_to: "callee" | "both";
    type: "text" | "audio_url";
    value: string;
  };
}

/** Build the Exotel Connect applet response body from resolved config. */
export function buildConnectResponse(
  config: ConnectConfig,
): ExotelConnectResponse {
  const response: ExotelConnectResponse = {
    destination: { numbers: config.numbers },
    fetch_after_attempt: config.fetchAfterAttempt,
    record: config.record,
    recording_channels: config.recordingChannels,
    max_ringing_duration: config.maxRingingDuration,
    max_conversation_duration: config.maxConversationDuration,
    music_on_hold: { type: config.musicOnHoldType },
  };

  if (config.outgoingPhoneNumber) {
    response.outgoing_phone_number = config.outgoingPhoneNumber;
  }

  if (config.waitMessage.trim()) {
    response.start_call_playback = {
      playback_to: "both",
      type: "text",
      value: config.waitMessage.trim(),
    };
  }

  return response;
}

/**
 * Normalise a phone number to E.164 (`+<cc><national>`), which is the only form
 * Exotel's Connect destination accepts reliably. Accepts a raw 10-digit number
 * (`7872944208`), a country-coded one (`917872944208`), or an already-formatted
 * `+91...`; strips spaces, hyphens and brackets from any of them.
 */
export function toE164(raw: string, countryCode = "91"): string {
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

export function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export function parseIntClamped(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number.parseInt((value ?? "").trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
