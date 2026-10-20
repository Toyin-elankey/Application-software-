// Per-line quantity limit (D-09: per-item limit 10). Matches the CartItem CHECK upper bound of 99 in SQL.
export const MAX_LINE_QUANTITY = 10;

export function assertValidQuantity(quantity: unknown): asserts quantity is number {
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY) {
    throw new RangeError(`quantity must be a whole number from 1 to ${MAX_LINE_QUANTITY}`);
  }
}
