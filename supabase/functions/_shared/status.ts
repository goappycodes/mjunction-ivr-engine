/**
 * Recipient status machine — must stay identical to mjunction's
 * `src/lib/domain/status.ts` (STATUS_TRANSITIONS / canTransition). That app and
 * this one write to the same `recipients` row, so a transition this function
 * allows but the admin panel doesn't (or vice versa) would silently desync the
 * two. There is no shared package between the Next.js app and these Deno edge
 * functions, so this is a deliberate, small, hand-kept-in-sync copy rather than
 * an import — if the admin panel's status graph changes, mirror the change
 * here too.
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
    "order_confirm_pending", // retry
  ],
  address_confirmed: ["dispatched"],
  address_corrected: ["dispatched", "address_confirmed"],
  order_unreachable: [
    "order_confirm_pending",
    "address_confirmed",
    "address_corrected",
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
  issue_raised: ["closed", "delivery_confirm_pending"],
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
  // corrected | issue_raised | transferred_to_agent -> stays put.
  return from;
}
