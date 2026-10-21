import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { getEnv } from '@/lib/env';

// Customer sessions (02 §8). The cookie holds an opaque token; the database holds its SHA-256 only.
//
// Two kinds share the table:
// - a sign-in session (cookie `customer_session`, 30 days), which opens all of the customer's orders;
// - an order-lookup session (cookie `order_session`, 30 minutes), which opens exactly one order. It is
//   separate, so looking up one order never signs a customer out of their account.

export const CUSTOMER_COOKIE = 'customer_session';
export const ORDER_COOKIE = 'order_session';
export const CUSTOMER_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
export const ORDER_SESSION_MS = 30 * 60 * 1000;

export type CustomerAccess = {
  customerId: string;
  /** Null for a sign-in session; the order id for a lookup session. */
  scopeOrderId: string | null;
  sessionId: string;
  kind: 'sign-in' | 'order-lookup';
};

export function newCustomerToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashCustomerToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Reads one cookie value from a Cookie header. Null when absent or malformed. */
export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    return /^[A-Za-z0-9_-]{20,128}$/.test(value) ? value : null;
  }
  return null;
}

function cookieSecure(): boolean {
  return getEnv().APP_BASE_URL.startsWith('https://');
}

export function customerSetCookie(name: string, token: string, maxAgeSeconds: number): string {
  const parts = [`${name}=${token}`, 'Path=/', `Max-Age=${maxAgeSeconds}`, 'HttpOnly', 'SameSite=Lax'];
  if (cookieSecure()) parts.push('Secure');
  return parts.join('; ');
}

export function customerClearCookie(name: string): string {
  const parts = [`${name}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
  if (cookieSecure()) parts.push('Secure');
  return parts.join('; ');
}

export async function openCustomerSession(
  tx: Prisma.TransactionClient | PrismaClient,
  input: { customerId: string; scopeOrderId: string | null; now: Date },
): Promise<{ token: string; expiresAt: Date }> {
  const token = newCustomerToken();
  const ttl = input.scopeOrderId ? ORDER_SESSION_MS : CUSTOMER_SESSION_MS;
  const expiresAt = new Date(input.now.getTime() + ttl);
  await tx.customerSession.create({
    data: {
      customerId: input.customerId,
      scopeOrderId: input.scopeOrderId,
      tokenHash: hashCustomerToken(token),
      expiresAt,
      createdAt: input.now,
      lastSeenAt: input.now,
    },
  });
  return { token, expiresAt };
}

/**
 * Looks up a session by its cookie value and applies every rule: not revoked, not expired, same business,
 * customer not erased. Returns null when the session is not usable; the caller answers 401.
 */
export async function resolveCustomerSession(
  db: PrismaClient,
  businessId: string,
  token: string | null,
  now = new Date(),
): Promise<CustomerAccess | null> {
  if (!token) return null;
  const session = await db.customerSession.findUnique({
    where: { tokenHash: hashCustomerToken(token) },
    select: {
      id: true,
      customerId: true,
      scopeOrderId: true,
      expiresAt: true,
      revokedAt: true,
      customer: { select: { businessId: true, anonymizedAt: true } },
    },
  });
  if (!session || session.revokedAt || session.expiresAt <= now) return null;
  if (session.customer.businessId !== businessId || session.customer.anonymizedAt) return null;
  return {
    customerId: session.customerId,
    scopeOrderId: session.scopeOrderId,
    sessionId: session.id,
    kind: session.scopeOrderId ? 'order-lookup' : 'sign-in',
  };
}

/** Every usable session named in this request's cookies (sign-in and lookup can both be present). */
export async function accessesFromCookies(
  db: PrismaClient,
  businessId: string,
  cookieHeader: string | null,
  now = new Date(),
): Promise<CustomerAccess[]> {
  const found: CustomerAccess[] = [];
  for (const name of [CUSTOMER_COOKIE, ORDER_COOKIE]) {
    const access = await resolveCustomerSession(db, businessId, readCookie(cookieHeader, name), now);
    if (access) found.push(access);
  }
  return found;
}

export async function revokeCustomerSession(db: PrismaClient, sessionId: string, now = new Date()): Promise<void> {
  await db.customerSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: now } });
}
