// Money formatting for display. Amounts are integer minor units (kobo for NGN) as BigInt.
// Calculations stay in BigInt; this function only renders. Display string: "₦12,500.00".

export function formatNaira(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const naira = abs / 100n;
  const kobo = (abs % 100n).toString().padStart(2, '0');
  const grouped = naira.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}₦${grouped}.${kobo}`;
}
