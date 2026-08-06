/**
 * Exotel "Connect Applet — Dynamic URL" response contract.
 *
 * When a Connect applet is configured with a Dynamic URL, Exotel makes a GET
 * request to that URL mid-call and expects a JSON body (HTTP 200,
 * Content-Type: application/json) describing whom to dial and how. The applet
 * then dials `destination.numbers` in order and bridges the caller to the first
 * one that answers.
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
 *
 * This module maps our provider-agnostic `ConnectConfig` onto that shape and
 * nothing else, so a change to Exotel's schema stays contained here.
 */
import type { ConnectConfig } from "./config.ts";

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

  // Optional greeting played when the bridge starts. "both" is a documented,
  // safe playback_to value. Off unless SUPPORT_WAIT_MESSAGE is set.
  if (config.waitMessage.trim()) {
    response.start_call_playback = {
      playback_to: "both",
      type: "text",
      value: config.waitMessage.trim(),
    };
  }

  return response;
}
