import { getEnv } from '@/lib/env';
import { getDb } from '@/server/db/client';
import { getStoreContext, type StoreContext } from '@/server/store';
import { cartCookieHeader, CART_COOKIE } from '@/server/cart/token';
import { AppError, jsonResponse } from './problem';
import type { PrismaClient } from '@prisma/client';

// Shared plumbing for the route handlers: database and store, JSON bodies, and the cart cookie.

export async function storeAndDb(): Promise<{ db: PrismaClient; store: StoreContext }> {
  const db = getDb();
  const store = await getStoreContext(db);
  return { db, store };
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AppError(400, 'invalid_json', 'The request body must be valid JSON.');
  }
}

export function cartCookieSecure(): boolean {
  return getEnv().APP_BASE_URL.startsWith('https://');
}

export function cartTokenFrom(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === CART_COOKIE) return rest.join('=') || null;
  }
  return null;
}

/** Adds a Set-Cookie header when a new cart token was issued. */
export function withNewCartCookie(headers: Headers, newToken: string | null): Headers {
  if (newToken) headers.append('Set-Cookie', cartCookieHeader(newToken, cartCookieSecure()));
  return headers;
}

/** JSON response with extra headers, such as a new cart cookie. */
export function jsonWithCookie(data: unknown, status: number, newToken: string | null): Response {
  const response = jsonResponse(data, status);
  withNewCartCookie(response.headers, newToken);
  return response;
}
