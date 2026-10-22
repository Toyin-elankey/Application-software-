import { clientMeta, requireJsonRequest } from '@/server/auth/guard';
import { getOtpSender } from '@/server/customers/delivery';
import { requestOtp } from '@/server/customers/otp';
import { OtpRequestSchema } from '@/server/customers/schema';
import { codeTargetPhone } from '@/server/customers/target';
import { handle, jsonResponse } from '@/server/http/problem';
import { readJson, storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

// POST /api/v1/auth/otp/request. Always answers 202 with the same body, whether or not a code was sent.
// A refused send (limit, unknown or erased target) looks the same as a real one.
export function POST(request: Request) {
  return handle(async () => {
    requireJsonRequest(request);
    const body = OtpRequestSchema.parse(await readJson(request));
    const { db, store } = await storeAndDb();
    const phoneE164 = await codeTargetPhone(db, store.scope, body);
    const result = await requestOtp(db, getOtpSender(), { businessId: store.scope.businessId, purpose: body.purpose, phoneE164, ip: clientMeta(request).ip });
    return jsonResponse(result, 202);
  });
}
