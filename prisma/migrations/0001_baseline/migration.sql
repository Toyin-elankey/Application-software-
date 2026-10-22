-- Baseline schema generated from prisma/schema.prisma by scripts/db/gen-baseline.mjs.
-- Do not edit by hand. Hand-written constraints live in later migrations.

CREATE TYPE "StaffRole" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'FULFILMENT', 'SUPPORT', 'FINANCE', 'VIEWER');
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'PAYMENT_CONFIRMED', 'CONFIRMED', 'PROCESSING', 'READY_FOR_DISPATCH', 'DISPATCHED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'REFUND_PENDING', 'REFUNDED');
CREATE TYPE "SalesChannel" AS ENUM ('WEB', 'WHATSAPP', 'AI_ASSISTANT', 'ADMIN');
CREATE TYPE "PaymentProvider" AS ENUM ('MOCK', 'PAYSTACK', 'FLUTTERWAVE');
CREATE TYPE "PaymentStatus" AS ENUM ('INITIALIZED', 'PENDING', 'SUCCEEDED', 'FAILED', 'ABANDONED');
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "InventoryReason" AS ENUM ('RESTOCK', 'ADJUSTMENT', 'RESERVED', 'RESERVATION_RELEASED', 'SOLD', 'RETURNED');
CREATE TYPE "CartStatus" AS ENUM ('ACTIVE', 'CONVERTED', 'ABANDONED');
CREATE TYPE "ActorType" AS ENUM ('SYSTEM', 'STAFF', 'CUSTOMER', 'AI', 'WEBHOOK');
CREATE TYPE "ConversationChannel" AS ENUM ('WEB_CHAT', 'WHATSAPP');
CREATE TYPE "ConversationMode" AS ENUM ('AI', 'HUMAN', 'CLOSED');
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');
CREATE TYPE "MessageDeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED');
CREATE TYPE "NotificationType" AS ENUM ('ORDER_CONFIRMED', 'PAYMENT_RECEIVED', 'ORDER_STATUS_UPDATE', 'DELIVERY_UPDATE', 'REFUND_UPDATE');
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED_NO_CONSENT', 'CANCELLED');
CREATE TYPE "TemplateCategory" AS ENUM ('UTILITY', 'AUTHENTICATION', 'MARKETING');
CREATE TYPE "TemplateStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED');
CREATE TYPE "ConsentPurpose" AS ENUM ('ORDER_UPDATES_WHATSAPP', 'MARKETING_WHATSAPP', 'AI_ASSISTANT_PROCESSING', 'TERMS_AND_PRIVACY');
CREATE TYPE "OtpPurpose" AS ENUM ('CUSTOMER_LOGIN', 'ORDER_LOOKUP', 'ORDER_CANCEL');
CREATE TYPE "DeliveryEventStatus" AS ENUM ('PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERY_ATTEMPTED', 'DELIVERED', 'RETURNED', 'DELAYED', 'NOTE');
CREATE TYPE "DeliveryEventSource" AS ENUM ('STAFF', 'PROVIDER');
CREATE TYPE "EstimateSource" AS ENUM ('PROVIDER', 'BUSINESS_CONFIGURED', 'NONE');
CREATE TYPE "WebhookProvider" AS ENUM ('WHATSAPP', 'PAYSTACK', 'FLUTTERWAVE');
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED');
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
CREATE TYPE "IdempotencyState" AS ENUM ('IN_PROGRESS', 'COMPLETED');
CREATE TYPE "ConfirmationAction" AS ENUM ('CHECKOUT');
CREATE TYPE "AiToolStatus" AS ENUM ('OK', 'ERROR', 'DENIED');

CREATE TABLE "Business" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "countryCode" CHAR(2) NOT NULL DEFAULT 'NG',
    "currency" CHAR(3) NOT NULL DEFAULT 'NGN',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Africa/Lagos',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Business_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Business_slug_key" ON "Business"("slug");

CREATE TABLE "BusinessSettings" (
    "businessId" UUID NOT NULL,
    "brandLogoUrl" VARCHAR(500),
    "primaryColor" VARCHAR(7),
    "accentColor" VARCHAR(7),
    "tagline" VARCHAR(160),
    "supportEmail" VARCHAR(254),
    "supportPhoneE164" VARCHAR(16),
    "whatsappDisplayNumber" VARCHAR(20),
    "addressText" VARCHAR(300),
    "deliveryPolicy" TEXT,
    "returnPolicy" TEXT,
    "refundPolicy" TEXT,
    "privacyPolicyUrl" VARCHAR(500),
    "pricesIncludeVat" BOOLEAN NOT NULL DEFAULT TRUE,
    "vatRateBps" INTEGER NOT NULL DEFAULT 750,
    "stockReservationMinutes" INTEGER NOT NULL DEFAULT 30,
    "orderNumberPrefix" VARCHAR(8) NOT NULL DEFAULT 'ORD',
    "aiAssistantEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
    "businessHours" JSONB,
    "notificationPreferences" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "BusinessSettings_pkey" PRIMARY KEY ("businessId")
);

CREATE TABLE "StaffUser" (
    "id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "fullName" VARCHAR(120) NOT NULL,
    "passwordHash" VARCHAR(255) NOT NULL,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT FALSE,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
    "mfaSecretEnc" VARCHAR(512),
    "mfaLastUsedStep" BIGINT,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(6),
    "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
    "lastLoginAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "StaffUser_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StaffUser_email_key" ON "StaffUser"("email");

CREATE TABLE "StaffSession" (
    "id" UUID NOT NULL,
    "staffUserId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "tokenVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL,
    "idleExpiresAt" TIMESTAMPTZ(6) NOT NULL,
    "absoluteExpiresAt" TIMESTAMPTZ(6) NOT NULL,
    "mfaVerifiedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "ip" VARCHAR(64),
    "userAgent" VARCHAR(255),
    CONSTRAINT "StaffSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StaffSession_tokenHash_key" ON "StaffSession"("tokenHash");
CREATE INDEX "StaffSession_staffUserId_idx" ON "StaffSession"("staffUserId");

CREATE TABLE "StaffMembership" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "staffUserId" UUID NOT NULL,
    "role" "StaffRole" NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StaffMembership_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StaffMembership_businessId_staffUserId_key" ON "StaffMembership"("businessId", "staffUserId");
CREATE INDEX "StaffMembership_staffUserId_idx" ON "StaffMembership"("staffUserId");

CREATE TABLE "Customer" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "phoneE164" VARCHAR(16) NOT NULL,
    "phoneVerifiedAt" TIMESTAMPTZ(6),
    "fullName" VARCHAR(120),
    "email" VARCHAR(254),
    "anonymizedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Customer_businessId_phoneE164_key" ON "Customer"("businessId", "phoneE164");

CREATE TABLE "CustomerSession" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "scopeOrderId" UUID,
    "tokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(6),
    CONSTRAINT "CustomerSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CustomerSession_tokenHash_key" ON "CustomerSession"("tokenHash");
CREATE INDEX "CustomerSession_customerId_idx" ON "CustomerSession"("customerId");

CREATE TABLE "OtpChallenge" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "phoneE164" VARCHAR(16) NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "codeHash" VARCHAR(64) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OtpChallenge_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OtpChallenge_businessId_phoneE164_purpose_createdAt_idx" ON "OtpChallenge"("businessId", "phoneE164", "purpose", "createdAt");

CREATE TABLE "RateLimitEvent" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "bucket" VARCHAR(160) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RateLimitEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RateLimitEvent_bucket_createdAt_idx" ON "RateLimitEvent"("bucket", "createdAt");

CREATE TABLE "ConsentRecord" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "purpose" "ConsentPurpose" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "source" VARCHAR(64) NOT NULL,
    "policyVersion" VARCHAR(32) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ConsentRecord_customerId_purpose_createdAt_idx" ON "ConsentRecord"("customerId", "purpose", "createdAt");

CREATE TABLE "Address" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "label" VARCHAR(40),
    "recipientName" VARCHAR(120) NOT NULL,
    "phoneE164" VARCHAR(16) NOT NULL,
    "line1" VARCHAR(200) NOT NULL,
    "line2" VARCHAR(200),
    "city" VARCHAR(100) NOT NULL,
    "state" VARCHAR(60) NOT NULL,
    "postalCode" VARCHAR(20),
    "landmark" VARCHAR(200),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Address_customerId_idx" ON "Address"("customerId");

CREATE TABLE "Category" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "parentId" UUID,
    "name" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Category_businessId_slug_key" ON "Category"("businessId", "slug");

CREATE TABLE "Product" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "categoryId" UUID,
    "slug" VARCHAR(120) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "shortDescription" VARCHAR(280),
    "description" TEXT NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Product_businessId_slug_key" ON "Product"("businessId", "slug");
CREATE INDEX "Product_businessId_status_idx" ON "Product"("businessId", "status");
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

CREATE TABLE "ProductImage" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "altText" VARCHAR(200) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProductImage_productId_sortOrder_idx" ON "ProductImage"("productId", "sortOrder");

CREATE TABLE "ProductOption" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ProductOption_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProductOption_productId_name_key" ON "ProductOption"("productId", "name");

CREATE TABLE "ProductOptionValue" (
    "id" UUID NOT NULL,
    "optionId" UUID NOT NULL,
    "value" VARCHAR(60) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ProductOptionValue_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProductOptionValue_optionId_value_key" ON "ProductOptionValue"("optionId", "value");

CREATE TABLE "ProductVariant" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "sku" VARCHAR(64) NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "priceMinor" BIGINT NOT NULL,
    "compareAtMinor" BIGINT,
    "weightGrams" INTEGER,
    "trackInventory" BOOLEAN NOT NULL DEFAULT TRUE,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT FALSE,
    "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProductVariant_businessId_sku_key" ON "ProductVariant"("businessId", "sku");
CREATE INDEX "ProductVariant_productId_idx" ON "ProductVariant"("productId");

CREATE TABLE "VariantOptionValue" (
    "variantId" UUID NOT NULL,
    "optionValueId" UUID NOT NULL,
    CONSTRAINT "VariantOptionValue_pkey" PRIMARY KEY ("variantId", "optionValueId")
);
CREATE INDEX "VariantOptionValue_optionValueId_idx" ON "VariantOptionValue"("optionValueId");

CREATE TABLE "InventoryMovement" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" "InventoryReason" NOT NULL,
    "orderId" UUID,
    "actorType" "ActorType" NOT NULL,
    "actorStaffId" UUID,
    "note" VARCHAR(255),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "InventoryMovement_variantId_createdAt_idx" ON "InventoryMovement"("variantId", "createdAt");
CREATE INDEX "InventoryMovement_orderId_idx" ON "InventoryMovement"("orderId");

CREATE TABLE "DeliveryZone" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "states" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "feeMinor" BIGINT NOT NULL,
    "freeShippingThresholdMinor" BIGINT,
    "etaLabel" VARCHAR(120),
    "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "DeliveryZone_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DeliveryZone_businessId_isActive_idx" ON "DeliveryZone"("businessId", "isActive");

CREATE TABLE "Cart" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "customerId" UUID,
    "conversationId" UUID,
    "channel" "SalesChannel" NOT NULL DEFAULT 'WEB',
    "tokenHash" VARCHAR(64),
    "status" "CartStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Cart_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Cart_tokenHash_key" ON "Cart"("tokenHash");
CREATE INDEX "Cart_businessId_status_expiresAt_idx" ON "Cart"("businessId", "status", "expiresAt");
CREATE INDEX "Cart_customerId_idx" ON "Cart"("customerId");

CREATE TABLE "CartItem" (
    "id" UUID NOT NULL,
    "cartId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "CartItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CartItem_cartId_variantId_key" ON "CartItem"("cartId", "variantId");

CREATE TABLE "Order" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "orderNumber" VARCHAR(20) NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "channel" "SalesChannel" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "subtotalMinor" BIGINT NOT NULL,
    "discountMinor" BIGINT NOT NULL DEFAULT 0,
    "shippingMinor" BIGINT NOT NULL DEFAULT 0,
    "taxMinor" BIGINT NOT NULL DEFAULT 0,
    "totalMinor" BIGINT NOT NULL,
    "deliveryZoneId" UUID,
    "deliveryZoneName" VARCHAR(80),
    "checkoutKey" VARCHAR(128) NOT NULL,
    "checkoutRequestHash" VARCHAR(64) NOT NULL,
    "reservationExpiresAt" TIMESTAMPTZ(6),
    "customerNote" VARCHAR(500),
    "internalNote" TEXT,
    "cancelReason" VARCHAR(255),
    "paidAt" TIMESTAMPTZ(6),
    "confirmedAt" TIMESTAMPTZ(6),
    "dispatchedAt" TIMESTAMPTZ(6),
    "deliveredAt" TIMESTAMPTZ(6),
    "cancelledAt" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Order_businessId_orderNumber_key" ON "Order"("businessId", "orderNumber");
CREATE UNIQUE INDEX "Order_businessId_checkoutKey_key" ON "Order"("businessId", "checkoutKey");
CREATE INDEX "Order_businessId_status_createdAt_idx" ON "Order"("businessId", "status", "createdAt");
CREATE INDEX "Order_businessId_customerId_createdAt_idx" ON "Order"("businessId", "customerId", "createdAt");
CREATE INDEX "Order_status_reservationExpiresAt_idx" ON "Order"("status", "reservationExpiresAt");

CREATE TABLE "OrderAddress" (
    "orderId" UUID NOT NULL,
    "recipientName" VARCHAR(120) NOT NULL,
    "phoneE164" VARCHAR(16) NOT NULL,
    "line1" VARCHAR(200) NOT NULL,
    "line2" VARCHAR(200),
    "city" VARCHAR(100) NOT NULL,
    "state" VARCHAR(60) NOT NULL,
    "postalCode" VARCHAR(20),
    "landmark" VARCHAR(200),
    CONSTRAINT "OrderAddress_pkey" PRIMARY KEY ("orderId")
);

CREATE TABLE "OrderItem" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "variantId" UUID,
    "sku" VARCHAR(64) NOT NULL,
    "productName" VARCHAR(160) NOT NULL,
    "variantTitle" VARCHAR(160) NOT NULL,
    "unitPriceMinor" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "lineTotalMinor" BIGINT NOT NULL,
    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

CREATE TABLE "OrderStatusEvent" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "fromStatus" "OrderStatus",
    "toStatus" "OrderStatus" NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" VARCHAR(64),
    "reason" VARCHAR(255),
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderStatusEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OrderStatusEvent_orderId_createdAt_idx" ON "OrderStatusEvent"("orderId", "createdAt");

CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "reference" VARCHAR(100) NOT NULL,
    "providerTransactionId" VARCHAR(100),
    "status" "PaymentStatus" NOT NULL DEFAULT 'INITIALIZED',
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "authorizationUrl" VARCHAR(500),
    "channel" VARCHAR(30),
    "failureReason" VARCHAR(255),
    "initializedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMPTZ(6),
    "verifiedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Payment_reference_key" ON "Payment"("reference");
CREATE UNIQUE INDEX "Payment_providerTransactionId_key" ON "Payment"("providerTransactionId");
CREATE INDEX "Payment_orderId_status_idx" ON "Payment"("orderId", "status");
CREATE INDEX "Payment_businessId_status_createdAt_idx" ON "Payment"("businessId", "status", "createdAt");

CREATE TABLE "Refund" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "reason" VARCHAR(255) NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "providerRefundId" VARCHAR(100),
    "failureReason" VARCHAR(255),
    "requestedByStaffId" UUID,
    "approvedByStaffId" UUID,
    "processedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Refund_providerRefundId_key" ON "Refund"("providerRefundId");
CREATE INDEX "Refund_orderId_idx" ON "Refund"("orderId");

CREATE TABLE "Shipment" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "provider" VARCHAR(40) NOT NULL DEFAULT 'MANUAL',
    "carrierName" VARCHAR(80),
    "trackingNumber" VARCHAR(80),
    "currentStatus" "DeliveryEventStatus",
    "etaFrom" TIMESTAMPTZ(6),
    "etaTo" TIMESTAMPTZ(6),
    "etaSource" "EstimateSource" NOT NULL DEFAULT 'NONE',
    "dispatchedAt" TIMESTAMPTZ(6),
    "deliveredAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Shipment_orderId_idx" ON "Shipment"("orderId");

CREATE TABLE "DeliveryEvent" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "status" "DeliveryEventStatus" NOT NULL,
    "description" VARCHAR(255),
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "source" "DeliveryEventSource" NOT NULL,
    "providerEventId" VARCHAR(100),
    "recordedByStaffId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeliveryEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DeliveryEvent_providerEventId_key" ON "DeliveryEvent"("providerEventId");
CREATE INDEX "DeliveryEvent_orderId_occurredAt_idx" ON "DeliveryEvent"("orderId", "occurredAt");

CREATE TABLE "Conversation" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "customerId" UUID,
    "channel" "ConversationChannel" NOT NULL,
    "externalId" VARCHAR(128) NOT NULL,
    "mode" "ConversationMode" NOT NULL DEFAULT 'AI',
    "assignedStaffId" UUID,
    "lastInboundAt" TIMESTAMPTZ(6),
    "verifiedCustomerId" UUID,
    "verifiedUntil" TIMESTAMPTZ(6),
    "summary" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Conversation_businessId_channel_externalId_key" ON "Conversation"("businessId", "channel", "externalId");
CREATE INDEX "Conversation_businessId_mode_updatedAt_idx" ON "Conversation"("businessId", "mode", "updatedAt");

CREATE TABLE "Message" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "senderType" "ActorType" NOT NULL,
    "senderStaffId" UUID,
    "providerMessageId" VARCHAR(128),
    "kind" VARCHAR(30) NOT NULL,
    "body" TEXT,
    "payload" JSONB,
    "deliveryStatus" "MessageDeliveryStatus",
    "errorCode" VARCHAR(30),
    "idempotencyKey" VARCHAR(128),
    "retentionUntil" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusUpdatedAt" TIMESTAMPTZ(6),
    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Message_providerMessageId_key" ON "Message"("providerMessageId");
CREATE UNIQUE INDEX "Message_idempotencyKey_key" ON "Message"("idempotencyKey");
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
CREATE INDEX "Message_retentionUntil_idx" ON "Message"("retentionUntil");

CREATE TABLE "WhatsAppAccount" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "wabaId" VARCHAR(40) NOT NULL,
    "phoneNumberId" VARCHAR(40) NOT NULL,
    "displayPhoneNumber" VARCHAR(20) NOT NULL,
    "verifiedName" VARCHAR(120),
    "mode" VARCHAR(10) NOT NULL DEFAULT 'MOCK',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "WhatsAppAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WhatsAppAccount_businessId_key" ON "WhatsAppAccount"("businessId");
CREATE UNIQUE INDEX "WhatsAppAccount_phoneNumberId_key" ON "WhatsAppAccount"("phoneNumberId");

CREATE TABLE "MessageTemplate" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "internalKey" VARCHAR(60) NOT NULL,
    "providerName" VARCHAR(120) NOT NULL,
    "language" VARCHAR(10) NOT NULL DEFAULT 'en',
    "category" "TemplateCategory" NOT NULL,
    "status" "TemplateStatus" NOT NULL DEFAULT 'PENDING',
    "variableSchema" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MessageTemplate_businessId_internalKey_language_key" ON "MessageTemplate"("businessId", "internalKey", "language");

CREATE TABLE "WhatsAppNotification" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "orderId" UUID,
    "templateId" UUID,
    "type" "NotificationType" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "dedupeKey" VARCHAR(160) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "providerMessageId" VARCHAR(128),
    "lastErrorCode" VARCHAR(30),
    "lastErrorMessage" VARCHAR(255),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "WhatsAppNotification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WhatsAppNotification_dedupeKey_key" ON "WhatsAppNotification"("dedupeKey");
CREATE UNIQUE INDEX "WhatsAppNotification_providerMessageId_key" ON "WhatsAppNotification"("providerMessageId");
CREATE INDEX "WhatsAppNotification_status_nextAttemptAt_idx" ON "WhatsAppNotification"("status", "nextAttemptAt");
CREATE INDEX "WhatsAppNotification_businessId_createdAt_idx" ON "WhatsAppNotification"("businessId", "createdAt");

CREATE TABLE "WebhookEvent" (
    "id" UUID NOT NULL,
    "businessId" UUID,
    "provider" "WebhookProvider" NOT NULL,
    "externalId" VARCHAR(160) NOT NULL,
    "eventType" VARCHAR(80),
    "signatureValid" BOOLEAN NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(500),
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(6),
    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WebhookEvent_provider_externalId_key" ON "WebhookEvent"("provider", "externalId");
CREATE INDEX "WebhookEvent_status_receivedAt_idx" ON "WebhookEvent"("status", "receivedAt");

CREATE TABLE "Job" (
    "id" UUID NOT NULL,
    "businessId" UUID,
    "type" VARCHAR(60) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "runAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "lockedUntil" TIMESTAMPTZ(6),
    "dedupeKey" VARCHAR(160),
    "lastError" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Job_dedupeKey_key" ON "Job"("dedupeKey");
CREATE INDEX "Job_status_runAt_idx" ON "Job"("status", "runAt");

CREATE TABLE "IdempotencyKey" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "scope" VARCHAR(60) NOT NULL,
    "keyHash" VARCHAR(64) NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "state" "IdempotencyState" NOT NULL DEFAULT 'IN_PROGRESS',
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IdempotencyKey_businessId_scope_keyHash_key" ON "IdempotencyKey"("businessId", "scope", "keyHash");
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");

CREATE TABLE "ConfirmationRequest" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "cartId" UUID NOT NULL,
    "customerId" UUID,
    "conversationId" UUID,
    "action" "ConfirmationAction" NOT NULL,
    "snapshotHash" VARCHAR(64) NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConfirmationRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ConfirmationRequest_tokenHash_key" ON "ConfirmationRequest"("tokenHash");
CREATE INDEX "ConfirmationRequest_cartId_expiresAt_idx" ON "ConfirmationRequest"("cartId", "expiresAt");

CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" VARCHAR(64),
    "action" VARCHAR(80) NOT NULL,
    "entityType" VARCHAR(40) NOT NULL,
    "entityId" VARCHAR(64),
    "changes" JSONB,
    "ip" VARCHAR(64),
    "userAgent" VARCHAR(255),
    "requestId" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditLog_businessId_createdAt_idx" ON "AuditLog"("businessId", "createdAt");
CREATE INDEX "AuditLog_businessId_entityType_entityId_idx" ON "AuditLog"("businessId", "entityType", "entityId");

CREATE TABLE "AiToolInvocation" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "toolName" VARCHAR(60) NOT NULL,
    "status" "AiToolStatus" NOT NULL,
    "inputRedacted" JSONB NOT NULL,
    "resultSummary" JSONB,
    "errorCode" VARCHAR(40),
    "latencyMs" INTEGER NOT NULL,
    "model" VARCHAR(60),
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiToolInvocation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AiToolInvocation_conversationId_createdAt_idx" ON "AiToolInvocation"("conversationId", "createdAt");
CREATE INDEX "AiToolInvocation_businessId_toolName_createdAt_idx" ON "AiToolInvocation"("businessId", "toolName", "createdAt");

-- Foreign keys
ALTER TABLE "BusinessSettings" ADD CONSTRAINT "BusinessSettings_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StaffSession" ADD CONSTRAINT "StaffSession_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "StaffUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StaffMembership" ADD CONSTRAINT "StaffMembership_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StaffMembership" ADD CONSTRAINT "StaffMembership_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "StaffUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerSession" ADD CONSTRAINT "CustomerSession_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OtpChallenge" ADD CONSTRAINT "OtpChallenge_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RateLimitEvent" ADD CONSTRAINT "RateLimitEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Address" ADD CONSTRAINT "Address_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Address" ADD CONSTRAINT "Address_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Category" ADD CONSTRAINT "Category_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Product" ADD CONSTRAINT "Product_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductOption" ADD CONSTRAINT "ProductOption_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductOptionValue" ADD CONSTRAINT "ProductOptionValue_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "ProductOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VariantOptionValue" ADD CONSTRAINT "VariantOptionValue_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VariantOptionValue" ADD CONSTRAINT "VariantOptionValue_optionValueId_fkey" FOREIGN KEY ("optionValueId") REFERENCES "ProductOptionValue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_actorStaffId_fkey" FOREIGN KEY ("actorStaffId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeliveryZone" ADD CONSTRAINT "DeliveryZone_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_deliveryZoneId_fkey" FOREIGN KEY ("deliveryZoneId") REFERENCES "DeliveryZone"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrderAddress" ADD CONSTRAINT "OrderAddress_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrderStatusEvent" ADD CONSTRAINT "OrderStatusEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeliveryEvent" ADD CONSTRAINT "DeliveryEvent_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeliveryEvent" ADD CONSTRAINT "DeliveryEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeliveryEvent" ADD CONSTRAINT "DeliveryEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assignedStaffId_fkey" FOREIGN KEY ("assignedStaffId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WhatsAppAccount" ADD CONSTRAINT "WhatsAppAccount_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WhatsAppNotification" ADD CONSTRAINT "WhatsAppNotification_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WhatsAppNotification" ADD CONSTRAINT "WhatsAppNotification_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WhatsAppNotification" ADD CONSTRAINT "WhatsAppNotification_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WhatsAppNotification" ADD CONSTRAINT "WhatsAppNotification_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MessageTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Job" ADD CONSTRAINT "Job_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IdempotencyKey" ADD CONSTRAINT "IdempotencyKey_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConfirmationRequest" ADD CONSTRAINT "ConfirmationRequest_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConfirmationRequest" ADD CONSTRAINT "ConfirmationRequest_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConfirmationRequest" ADD CONSTRAINT "ConfirmationRequest_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiToolInvocation" ADD CONSTRAINT "AiToolInvocation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiToolInvocation" ADD CONSTRAINT "AiToolInvocation_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;