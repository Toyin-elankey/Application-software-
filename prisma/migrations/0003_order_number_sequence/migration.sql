-- Order numbers come from one sequence per database (e.g. ORD-260001). Gaps are allowed (PRD A-14).
-- Unique per business through "Order"("businessId", "orderNumber").
CREATE SEQUENCE IF NOT EXISTS "order_number_seq" START WITH 1 INCREMENT BY 1 MINVALUE 1;
