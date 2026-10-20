// Order lifecycle transitions (PRD §7). Pure and exhaustively tested: every (from, to, actor) triple
// is either allowed or rejected. The caller applies the transition in a transaction with a version check.

export const ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'PAYMENT_CONFIRMED',
  'CONFIRMED',
  'PROCESSING',
  'READY_FOR_DISPATCH',
  'DISPATCHED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
  'REFUND_PENDING',
  'REFUNDED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ACTORS = ['SYSTEM', 'STAFF', 'CUSTOMER', 'AI', 'WEBHOOK'] as const;
export type Actor = (typeof ACTORS)[number];

type Rule = { from: OrderStatus; to: OrderStatus; actors: readonly Actor[] };

// Rules from PRD §7. Two deliberate readings are flagged here:
// - PAYMENT_CONFIRMED -> REFUND_PENDING also allows CUSTOMER. FR-ORD-06 lets a customer cancel
//   while PAYMENT_CONFIRMED, and a paid cancellation moves to REFUND_PENDING.
// - A provider event may move an order out for delivery or deliver it (SYSTEM), as the PRD allows.
export const TRANSITIONS: readonly Rule[] = [
  { from: 'PENDING_PAYMENT', to: 'PAYMENT_CONFIRMED', actors: ['SYSTEM'] },
  { from: 'PENDING_PAYMENT', to: 'CANCELLED', actors: ['SYSTEM', 'CUSTOMER'] },
  { from: 'PAYMENT_CONFIRMED', to: 'CONFIRMED', actors: ['STAFF'] },
  { from: 'PAYMENT_CONFIRMED', to: 'REFUND_PENDING', actors: ['STAFF', 'CUSTOMER'] },
  { from: 'CONFIRMED', to: 'REFUND_PENDING', actors: ['STAFF'] },
  { from: 'CONFIRMED', to: 'PROCESSING', actors: ['STAFF'] },
  { from: 'PROCESSING', to: 'READY_FOR_DISPATCH', actors: ['STAFF'] },
  { from: 'READY_FOR_DISPATCH', to: 'DISPATCHED', actors: ['STAFF'] },
  { from: 'DISPATCHED', to: 'OUT_FOR_DELIVERY', actors: ['STAFF', 'SYSTEM'] },
  { from: 'OUT_FOR_DELIVERY', to: 'DELIVERED', actors: ['STAFF', 'SYSTEM'] },
  { from: 'OUT_FOR_DELIVERY', to: 'DISPATCHED', actors: ['STAFF'] },
  { from: 'DELIVERED', to: 'REFUND_PENDING', actors: ['STAFF'] },
  { from: 'CONFIRMED', to: 'CANCELLED', actors: ['STAFF'] },
  { from: 'PROCESSING', to: 'CANCELLED', actors: ['STAFF'] },
  { from: 'READY_FOR_DISPATCH', to: 'CANCELLED', actors: ['STAFF'] },
  { from: 'REFUND_PENDING', to: 'REFUNDED', actors: ['SYSTEM'] },
  // Late payment reinstatement (06 §5): a payment verified after the reservation expired, with stock
  // still available, moves the order back to paid. Only the payment confirmation path uses this.
  { from: 'CANCELLED', to: 'PAYMENT_CONFIRMED', actors: ['SYSTEM'] },
];

export type TransitionContext = {
  /** True once a payment has been verified. Paid orders are refunded, not cancelled (PRD §7). */
  paid: boolean;
};

export type TransitionResult = { ok: true } | { ok: false; reason: string };

export function canTransition(
  from: OrderStatus,
  to: OrderStatus,
  actor: Actor,
  context: TransitionContext = { paid: false },
): TransitionResult {
  const rule = TRANSITIONS.find((r) => r.from === from && r.to === to);
  if (!rule) return { ok: false, reason: `transition ${from} -> ${to} is not allowed` };
  if (!rule.actors.includes(actor)) return { ok: false, reason: `${actor} may not move an order ${from} -> ${to}` };
  if (to === 'CANCELLED' && from !== 'PENDING_PAYMENT' && context.paid) {
    return { ok: false, reason: 'a paid order cannot be cancelled; request a refund (REFUND_PENDING)' };
  }
  return { ok: true };
}

/** Statuses from which the order can still be paid. Used by payment confirmation. */
export function isAwaitingPayment(status: OrderStatus): boolean {
  return status === 'PENDING_PAYMENT';
}
