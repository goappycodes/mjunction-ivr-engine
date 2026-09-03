/**
 * Which of the two IVR scripts a given call is running.
 *
 * Both scripts run on the **same Exotel app / App ID and the same flow
 * graph**. That is possible because the delivery-confirmation script has the
 * exact same shape as the order-confirmation one — a greeting, one menu, and
 * a closing message on each of the two terminal branches — and because every
 * word a caller hears is served by this project's own dynamic URLs, not
 * configured in Exotel's flow builder. Exotel only ever decides *which URL to
 * call*; this module decides *what that URL says*.
 *
 *   Flow node (same for both)         order_confirmation     delivery_confirmation
 *   ------------------------------    -------------------    ---------------------
 *   Greeting  /greeting               who is calling, why    who is calling, why
 *   Gather    /welcome                is this address right  did it arrive, intact
 *   Gather    /done      (case 1)     address confirmed      delivery confirmed
 *   Gather    /issue     (case 2)     address change asked   delivery issue raised
 *
 * The variant travels with the call in Exotel's `CustomField`, which is the
 * only per-call value Exotel echoes to every applet request. Encoding it there
 * rather than looking it up per request keeps every applet endpoint on its
 * existing single-DB-read budget (Exotel abandons an applet URL after 5s).
 */
import type { RecipientStatus } from "./status.ts";

export type CallFlow = "order_confirmation" | "delivery_confirmation";

/**
 * Suffix appended to the order id in `CustomField`, e.g. `ORDER110121|dc`.
 *
 * An *absent* suffix means order confirmation, so every call placed before
 * this change — and any inbound call, which carries no CustomField at all —
 * keeps behaving exactly as it did.
 */
const FLOW_SUFFIX: Record<CallFlow, string> = {
  order_confirmation: "oc",
  delivery_confirmation: "dc",
};

/**
 * Accept more than one separator on the way back in. `|` is what we send, but
 * it is percent-encoded on the wire and passes through a provider we do not
 * control, so the parser is deliberately more permissive than the encoder.
 */
const SEPARATORS = /[|:~]/;

export function encodeCustomField(orderId: string, flow: CallFlow): string {
  return `${orderId}|${FLOW_SUFFIX[flow]}`;
}

export interface ParsedCustomField {
  orderId: string;
  /** null when the field carried no recognisable flow suffix. */
  flow: CallFlow | null;
}

/**
 * Split a `CustomField` back into the order id and (if present) the flow.
 *
 * An unrecognised suffix is treated as part of the order id rather than
 * silently dropped — better to fail the order lookup loudly than to dial up
 * the wrong recipient's details because a separator appeared in a real
 * `unique_id`.
 */
export function parseCustomField(raw: string): ParsedCustomField {
  const value = (raw ?? "").trim();
  if (!value) return { orderId: "", flow: null };

  const match = value.split(SEPARATORS);
  if (match.length < 2) return { orderId: value, flow: null };

  const suffix = match[match.length - 1].trim().toLowerCase();
  for (const [flow, code] of Object.entries(FLOW_SUFFIX)) {
    if (suffix === code) {
      return {
        orderId: match.slice(0, -1).join("|").trim(),
        flow: flow as CallFlow,
      };
    }
  }

  return { orderId: value, flow: null };
}

/** Recipient statuses an order-confirmation call is valid for. Mirrors mjunction's ORDER_CALLABLE. */
export const ORDER_CALLABLE: RecipientStatus[] = [
  "imported",
  "order_confirm_pending",
  "order_unreachable",
];

/** Recipient statuses a delivery-confirmation call is valid for. Mirrors mjunction's DELIVERY_CALLABLE. */
export const DELIVERY_CALLABLE: RecipientStatus[] = [
  "delivery_confirm_pending",
  "delivery_unreachable",
];

/**
 * Fallback when `CustomField` arrives without a flow suffix: infer it from
 * where the recipient currently sits in the pipeline. Only used when the
 * explicit signal is missing (an inbound call, or a provider that mangled the
 * field), never in preference to it — a status can legitimately have moved on
 * mid-call, which is exactly why it isn't the primary source.
 */
export function inferFlowFromStatus(status: RecipientStatus | null | undefined): CallFlow {
  return status && DELIVERY_CALLABLE.includes(status)
    ? "delivery_confirmation"
    : "order_confirmation";
}
