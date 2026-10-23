// Business days are Lagos days (MVP: Lagos, NGN; 01 §1). Nigeria has no daylight saving, so the offset is fixed at UTC+1.
const LAGOS_OFFSET_MS = 60 * 60 * 1000;

/** The instant at which the Lagos calendar day containing `now` began. */
export function lagosDayStart(now: Date): Date {
  const shifted = new Date(now.getTime() + LAGOS_OFFSET_MS);
  const midnightShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(midnightShifted - LAGOS_OFFSET_MS);
}
