/**
 * Recipient status machine — must stay identical to mjunction's
 * `src/lib/domain/status.ts` (STATUS_TRANSITIONS / canTransition). That app and
 * this one write to the same `recipients` row, so a transition this function
 * allows but the admin panel doesn't (or vice versa) would silently desync the
 * two. There is no shared package between the Next.js app and these Deno edge
 * functions, so this is a deliberate, small, hand-kept-in-sync copy rather than
 * an import — if the admin panel's status graph changes, mirror the change
 * here too.
 *
 * ISSUE_RAISED — every press-2 lands here.
 * The IVR used to live-transfer a press-2 caller to their telecaller, which
 * left the recipient at `order_confirm_pending` with the escalation recorded
 * only as a `call_attempts.outcome`. That transfer is retired: pressing 2 on
 * any menu, in either half of the pipeline, now moves the recipient to
 * `issue_raised` and the escalations queue reads that status directly. No new
 * enum value was added — `issue_raised` already meant exactly this, it just
 * used to be reachable only from the delivery half.
 */

export type RecipientStatus =
  | "imported"
  | "order_confirm_pending"
  | "address_confirmed"
  | "address_corrected"
  | "order_unreachable"
  | "dispatched"
  | "delivered"
  | "delivery_confirm_pending"
  | "confirmed"
  | "issue_raised"
  | "delivery_unreachable"
  | "closed";

export const STATUS_TRANSITIONS: Record<RecipientStatus, RecipientStatus[]> = {
  imported: ["order_confirm_pending"],
  order_confirm_pending: [
    "address_confirmed",
    "address_corrected",
    "order_unreachable",
    "issue_raised", // press 2 on either menu — see the ISSUE_RAISED note above
    "order_confirm_pending", // retry
  ],
  address_confirmed: ["dispatched"],
  address_corrected: ["dispatched", "address_confirmed"],
  order_unreachable: [
    "order_confirm_pending",
    "address_confirmed",
    "address_corrected",
    "issue_raised",
  ],
  dispatched: ["delivered"],
  delivered: ["delivery_confirm_pending"],
  delivery_confirm_pending: [
    "confirmed",
    "issue_raised",
    "delivery_unreachable",
    "delivery_confirm_pending", // retry
  ],
  confirmed: ["closed"],
  // Raised from BOTH halves of the pipeline now, so it has to be resolvable
  // back into either — an order-phase escalation ends with the agent capturing
  // the address, a delivery-phase one ends closed or re-queued.
  issue_raised: [
    "closed",
    "delivery_confirm_pending",
    "address_confirmed",
    "address_corrected",
    "order_confirm_pending",
  ],
  delivery_unreachable: [
    "delivery_confirm_pending",
    "confirmed",
    "issue_raised",
  ],
  closed: [],
};

export function canTransition(
  from: RecipientStatus,
  to: RecipientStatus,
): boolean {
  if (from === to) return true;
  return STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Call outcomes, as recorded on `call_attempts.outcome`. */
export type CallOutcome =
  | "confirmed"
  | "corrected"
  | "no_answer"
  | "wrong_number"
  | "issue_raised"
  | "transferred_to_agent"
  | "not_reachable";

/**
 * Order-confirmation outcome -> status mapping. Mirrors the function of the
 * same name in mjunction's `src/lib/domain/status.ts` (kept in sync by hand,
 * same as STATUS_TRANSITIONS above): only `confirmed` and the not-reached
 * family advance the recipient; a reported address problem or an agent
 * transfer leaves it at `order_confirm_pending` on purpose — those need a
 * human to resolve before the pipeline can move on, and the call's outcome
 * (not the recipient status) is what the escalations/unreachable queues key
 * off.
 */
export function orderConfirmationStatusFor(
  outcome: CallOutcome,
  from: RecipientStatus,
): RecipientStatus {
  if (outcome === "confirmed") return "address_confirmed";
  if (
    outcome === "no_answer" ||
    outcome === "wrong_number" ||
    outcome === "not_reachable"
  ) {
    return "order_unreachable";
  }
  if (outcome === "issue_raised" || outcome === "transferred_to_agent") {
    return "issue_raised";
  }
  // `corrected` stays put: it is written by the agent resolving an escalation,
  // which applies its own transition, not by the IVR.
  return from;
}

/**
 * Delivery-confirmation outcome -> status mapping, and the counterpart of
 * `orderConfirmationStatusFor` for the second half of the pipeline. Mirrors
 * the function of the same name in mjunction's `src/lib/domain/status.ts`
 * (kept in sync by hand, same as everything else in this module).
 *
 * Same philosophy as the order side: a clean confirm advances the recipient, a
 * never-reached call marks it unreachable, and a press-2 raises an issue.
 * `transferred_to_agent` maps here too, only because historical rows carry it
 * — the live transfer itself is retired (see the ISSUE_RAISED note above).
 */
export function deliveryConfirmationStatusFor(
  outcome: CallOutcome,
  from: RecipientStatus,
): RecipientStatus {
  if (outcome === "confirmed") return "confirmed";
  if (outcome === "issue_raised" || outcome === "transferred_to_agent") {
    return "issue_raised";
  }
  if (
    outcome === "no_answer" ||
    outcome === "wrong_number" ||
    outcome === "not_reachable"
  ) {
    return "delivery_unreachable";
  }
  // `corrected` stays put — agent-written, same as on the order side.
  return from;
}
