-- Hand-written constraints from docs/03-data-model.md §9. Prisma's schema language cannot express
-- these. Each one is asserted by tests/db/constraints.test.ts.
-- Rollback: the statements under "Down" at the end of this file, run by hand in reverse order.
-- They drop only constraints, indexes and the generated search column. No table data is removed.

-- Non-negative stock and reservation bound
ALTER TABLE "ProductVariant"
  ADD CONSTRAINT variant_onhand_nonneg CHECK ("onHand" >= 0),
  ADD CONSTRAINT variant_reserved_bounds CHECK ("reserved" >= 0 AND "reserved" <= "onHand"),
  ADD CONSTRAINT variant_price_positive CHECK ("priceMinor" > 0);

-- Cart and order item arithmetic
ALTER TABLE "CartItem"  ADD CONSTRAINT cartitem_qty_range CHECK (quantity BETWEEN 1 AND 99);
ALTER TABLE "OrderItem" ADD CONSTRAINT orderitem_line_math CHECK ("lineTotalMinor" = "unitPriceMinor" * quantity);
ALTER TABLE "Order"     ADD CONSTRAINT order_total_math CHECK ("totalMinor" = "subtotalMinor" - "discountMinor" + "shippingMinor");
ALTER TABLE "Order"     ADD CONSTRAINT order_amounts_nonneg CHECK ("subtotalMinor" >= 0 AND "discountMinor" >= 0 AND "shippingMinor" >= 0);

-- Refund amounts
ALTER TABLE "Refund" ADD CONSTRAINT refund_amount_positive CHECK ("amountMinor" > 0);

-- Paid timestamp invariant (statuses at or after PAYMENT_CONFIRMED)
ALTER TABLE "Order" ADD CONSTRAINT order_paid_invariant CHECK (
  "status" NOT IN ('PAYMENT_CONFIRMED','CONFIRMED','PROCESSING','READY_FOR_DISPATCH',
                   'DISPATCHED','OUT_FOR_DELIVERY','DELIVERED','REFUND_PENDING','REFUNDED')
  OR "paidAt" IS NOT NULL
);

-- Full-text search over products (generated column + GIN index)
ALTER TABLE "Product" ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce(name,'')), 'A') ||
  setweight(to_tsvector('english', coalesce("shortDescription",'')), 'B') ||
  setweight(to_tsvector('english', coalesce(description,'')), 'C')
) STORED;
CREATE INDEX product_search_idx ON "Product" USING GIN (search_tsv);
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX product_name_trgm_idx ON "Product" USING GIN (name gin_trgm_ops);

-- Partial index for the job runner
CREATE INDEX job_pending_idx ON "Job" ("runAt") WHERE status = 'PENDING';

-- Only one open (unconsumed, unexpired) confirmation per cart and action is useful
CREATE UNIQUE INDEX confirmation_one_open_per_cart
  ON "ConfirmationRequest" ("cartId", action) WHERE "consumedAt" IS NULL;

-- Down (manual rollback, run in this order):
-- DROP INDEX IF EXISTS confirmation_one_open_per_cart;
-- DROP INDEX IF EXISTS job_pending_idx;
-- DROP INDEX IF EXISTS product_name_trgm_idx;
-- DROP INDEX IF EXISTS product_search_idx;
-- ALTER TABLE "Product" DROP COLUMN IF EXISTS search_tsv;
-- ALTER TABLE "Refund" DROP CONSTRAINT IF EXISTS refund_amount_positive;
-- ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS order_paid_invariant;
-- ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS order_amounts_nonneg;
-- ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS order_total_math;
-- ALTER TABLE "OrderItem" DROP CONSTRAINT IF EXISTS orderitem_line_math;
-- ALTER TABLE "CartItem" DROP CONSTRAINT IF EXISTS cartitem_qty_range;
-- ALTER TABLE "ProductVariant" DROP CONSTRAINT IF EXISTS variant_price_positive;
-- ALTER TABLE "ProductVariant" DROP CONSTRAINT IF EXISTS variant_reserved_bounds;
-- ALTER TABLE "ProductVariant" DROP CONSTRAINT IF EXISTS variant_onhand_nonneg;
-- The pg_trgm extension is left installed: other objects may depend on it.

