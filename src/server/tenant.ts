import { z } from 'zod';

// Every business-owned query takes a TenantScope. It is the only way to name the tenant, so a query
// cannot run without a business. Repository functions must put scope.businessId in their WHERE clause.
export const TenantScopeSchema = z.object({
  businessId: z.uuid({ error: 'businessId must be a UUID' }),
});

export type TenantScope = z.infer<typeof TenantScopeSchema>;

export function tenantScope(businessId: unknown): TenantScope {
  return TenantScopeSchema.parse({ businessId });
}
