import { z } from 'zod';

// Request bodies for customer OTP. The phone must be a Nigerian mobile number in E.164 form (MVP: Lagos
// delivery, NGN; 02 §6.2). Codes are exactly six digits.

export const PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+234\d{10}$/, { error: 'must be a Nigerian number, +234 followed by 10 digits' });

export const OrderNumberSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{2,8}-\d{6,}$/, { error: 'must look like ORD-260001' });

const CodeSchema = z.string().regex(/^\d{6}$/, { error: 'must be 6 digits' });

export const OtpRequestSchema = z.discriminatedUnion('purpose', [
  z.object({ purpose: z.literal('CUSTOMER_LOGIN'), phoneE164: PhoneSchema }).strict(),
  z.object({ purpose: z.literal('ORDER_LOOKUP'), orderNumber: OrderNumberSchema }).strict(),
]);

export const OtpVerifySchema = z.discriminatedUnion('purpose', [
  z.object({ purpose: z.literal('CUSTOMER_LOGIN'), phoneE164: PhoneSchema, code: CodeSchema }).strict(),
  z.object({ purpose: z.literal('ORDER_LOOKUP'), orderNumber: OrderNumberSchema, code: CodeSchema }).strict(),
]);
