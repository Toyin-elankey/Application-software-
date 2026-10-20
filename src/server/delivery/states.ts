// Nigerian states accepted for delivery addresses (36 states and the Federal Capital Territory).
// The list is the canonical spelling stored on orders and matched against zone coverage.

export const NIGERIAN_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta',
  'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'Federal Capital Territory', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano',
  'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau',
  'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara',
] as const;

export type NigerianState = (typeof NIGERIAN_STATES)[number];

const ALIASES: Record<string, NigerianState> = {
  fct: 'Federal Capital Territory',
  abuja: 'Federal Capital Territory',
  'fct abuja': 'Federal Capital Territory',
};

function key(input: string): string {
  return input.trim().replace(/\s+/g, ' ').replace(/\s+state$/i, '').toLowerCase();
}

const BY_KEY = new Map<string, NigerianState>(NIGERIAN_STATES.map((state) => [key(state), state]));

/** Returns the canonical state name, or null when the input is not a Nigerian state. Case-insensitive. */
export function canonicalState(input: string): NigerianState | null {
  const normalised = key(input);
  return BY_KEY.get(normalised) ?? ALIASES[normalised] ?? null;
}
