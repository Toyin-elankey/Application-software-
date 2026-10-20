import type { PrismaClient } from '@prisma/client';
import { getEnv } from '@/lib/env';
import { AppError } from '@/server/http/problem';
import { getStoreContext } from '@/server/store';
import { hasPermission, requiresMfa, type Permission } from './permissions';
import { resolveStaffActor, STAFF_COOKIE, type StaffActor } from './staff';

// Route guard for staff APIs. Every admin route calls requireStaff before reading or writing anything.
// The check order is fixed: session, then MFA for roles that need it, then the permission. The first
// failure answers, so a caller never learns more than the step it failed.

function cookieSecure(): boolean {
  return getEnv().APP_BASE_URL.startsWith('https://');
}

export function staffTokenFrom(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === STAFF_COOKIE) return decodeURIComponent(rest.join('=')) || null;
  }
  return null;
}

export function staffSetCookie(token: string): string {
  const parts = [`${STAFF_COOKIE}=${encodeURIComponent(token)}`, 'Path=/api', 'HttpOnly', 'SameSite=Strict'];
  if (cookieSecure()) parts.push('Secure');
  return parts.join('; ');
}

export function staffClearCookie(): string {
  const parts = [`${STAFF_COOKIE}=`, 'Path=/api', 'Max-Age=0', 'HttpOnly', 'SameSite=Strict'];
  if (cookieSecure()) parts.push('Secure');
  return parts.join('; ');
}

export function clientMeta(request: Request): { ip: string | null; userAgent: string | null } {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded ? forwarded.split(',')[0].trim().slice(0, 64) : null;
  return { ip, userAgent: request.headers.get('user-agent')?.slice(0, 255) ?? null };
}

/** State-changing requests must be JSON. A cross-site form cannot send application/json without a preflight. */
export function requireJsonRequest(request: Request): void {
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new AppError(415, 'unsupported_media_type', 'Send the request as application/json.');
  }
}

export async function requireStaff(
  db: PrismaClient,
  request: Request,
  options: { permission?: Permission; allowMfaSetup?: boolean } = {},
): Promise<StaffActor> {
  const store = await getStoreContext(db);
  const actor = await resolveStaffActor(db, store.scope.businessId, staffTokenFrom(request), clientMeta(request));
  if (!actor) throw new AppError(401, 'unauthenticated', 'Sign in to continue.');

  if (requiresMfa(actor.role) && !actor.mfaVerified && !options.allowMfaSetup) {
    throw new AppError(403, actor.mfaEnabled ? 'mfa_required' : 'mfa_enrolment_required', 'Two-factor sign-in must be completed first.', {
      mfaEnrolled: actor.mfaEnabled,
    });
  }
  if (options.permission && !hasPermission(actor.role, options.permission)) {
    throw new AppError(403, 'forbidden', 'Your role does not allow this action.');
  }
  return actor;
}
