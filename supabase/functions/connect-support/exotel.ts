/**
 * Exotel "Connect Applet — Dynamic URL" response contract, applied to support
 * config. The wire-format mapping itself lives in `../_shared/connect.ts`
 * (shared with connect-telecaller) — this module just re-exports it under
 * the name this function's `index.ts` already imports.
 */
export { buildConnectResponse, type ExotelConnectResponse } from "../_shared/connect.ts";
