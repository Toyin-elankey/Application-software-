import type { ConsentPurpose, NotificationType } from '@prisma/client';

// WhatsApp consent purposes (05 §2.6 "Consent sources", 03 retention). Pure: no database access here.

/** Policy text version for consent recorded from the account page (distinct from the checkout form's). */
export const CONSENT_POLICY_VERSION = '2026-10-stage5';

export const CONSENT_SOURCE_ACCOUNT = 'ACCOUNT_PAGE';

/**
 * Which queued notifications a withdrawal cancels (05 §2.6: "Pending notifications for that purpose become
 * CANCELLED"). Typed as a full record over ConsentPurpose, so adding a purpose will not compile until someone
 * decides what it covers. Stage 7 adds the template-backed rows; new NotificationType values go here too.
 */
const TYPES_BY_PURPOSE: Record<ConsentPurpose, readonly NotificationType[]> = {
  ORDER_UPDATES_WHATSAPP: ['ORDER_CONFIRMED', 'PAYMENT_RECEIVED', 'ORDER_STATUS_UPDATE', 'DELIVERY_UPDATE', 'REFUND_UPDATE'],
  // No marketing message type exists yet (Stage 7 and later).
  MARKETING_WHATSAPP: [],
  AI_ASSISTANT_PROCESSING: [],
  TERMS_AND_PRIVACY: [],
};

export function notificationTypesFor(purpose: ConsentPurpose): readonly NotificationType[] {
  return TYPES_BY_PURPOSE[purpose];
}

/** Order statuses from which a customer may cancel (FR-ORD-06). Later statuses are staff-only. */
export const CUSTOMER_CANCELLABLE_STATUSES = ['PENDING_PAYMENT', 'PAYMENT_CONFIRMED'] as const;

export function customerMayCancel(status: string): boolean {
  return (CUSTOMER_CANCELLABLE_STATUSES as readonly string[]).includes(status);
}
