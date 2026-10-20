// JSON helpers for money and other BigInt values.
//
// JSON has no BigInt type, and JSON.stringify throws on one. Money is stored in minor units
// (kobo for NGN) as BigInt, so every API response passes through this serializer. BigInt values
// become decimal strings, which keeps them exact. Converting them to Number would silently lose
// precision above 2^53.

export function toJsonSafe<T>(value: T): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((item) => toJsonSafe(item));
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, toJsonSafe(item)]),
    );
  }
  return value;
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(toJsonSafe(value));
}
