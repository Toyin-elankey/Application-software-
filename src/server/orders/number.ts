// Human-friendly order number: <prefix>-<2-digit year><4+ digit sequence>, e.g. ORD-260001.
// The sequence comes from a database sequence, so numbers are unique and gaps are allowed (PRD A-14).

export function formatOrderNumber(prefix: string, date: Date, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) throw new RangeError('sequence must be a positive integer');
  const year = String(date.getUTCFullYear() % 100).padStart(2, '0');
  return `${prefix}-${year}${String(sequence).padStart(4, '0')}`;
}
