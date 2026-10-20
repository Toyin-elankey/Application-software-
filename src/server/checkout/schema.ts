import { z } from 'zod';
import { canonicalState } from '@/server/delivery/states';
import { MAX_LINE_QUANTITY } from '@/server/cart/limits';
import { AppError } from '@/server/http/problem';

// Checkout request body. Amounts from the client are only used to detect changes: the server always
// prices from the database, and rejects the request if the customer saw different prices or items.

export const CHECKOUT_POLICY_VERSION = '2026-10-stage3';
export const MAX_CHECKOUT_LINES = 50;

const minorAmount = z.string().regex(/^\d{1,18}$/, { error: 'must be a whole number of kobo, as a string' });

export const CheckoutBodySchema = z.object({
  recipientName: z.string().trim().min(2).max(120),
  phoneE164: z.string().trim().regex(/^\+234\d{10}$/, { error: 'must be a Nigerian number, +234 followed by 10 digits' }),
  email: z.email({ error: 'must be a valid email address' }).max(254),
  address: z.object({
    line1: z.string().trim().min(3).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(2).max(100),
    state: z
      .string()
      .trim()
      .refine((value) => canonicalState(value) !== null, { error: 'choose a Nigerian state from the list' }),
    postalCode: z.string().trim().max(20).optional(),
    landmark: z.string().trim().max(200).optional(),
  }),
  customerNote: z.string().trim().max(500).optional(),
  // Unticked by default. Only an explicit true creates a consent record (FR-CHK-02).
  whatsappUpdates: z.boolean().default(false),
  // The cart the customer reviewed. Any difference from the server's view is a 409 with a diff.
  expected: z.object({
    totalMinor: minorAmount,
    lines: z
      .array(
        z.object({
          variantId: z.uuid(),
          quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
          unitPriceMinor: minorAmount,
        }),
      )
      .min(1)
      .max(MAX_CHECKOUT_LINES),
  }),
});

export type CheckoutBody = z.infer<typeof CheckoutBodySchema>;

/** Idempotency-Key: 1 to 128 printable ASCII characters (PRD FR-CHK-05). */
export function parseIdempotencyKey(value: string | null): string {
  if (!value || !/^[\x21-\x7e]{1,128}$/.test(value)) {
    throw new AppError(
      400,
      'idempotency_key_required',
      'An Idempotency-Key header (1 to 128 printable characters) is required.',
    );
  }
  return value;
}
