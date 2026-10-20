import { describe, expect, it } from 'vitest';
import { canonicalState, NIGERIAN_STATES } from './states';

describe('canonicalState', () => {
  it('lists 37 entries: 36 states and the FCT', () => {
    expect(NIGERIAN_STATES).toHaveLength(37);
    expect(new Set(NIGERIAN_STATES).size).toBe(37);
  });

  it.each([
    ['Lagos', 'Lagos'],
    ['lagos', 'Lagos'],
    ['  LAGOS  ', 'Lagos'],
    ['Lagos State', 'Lagos'],
    ['akwa   ibom', 'Akwa Ibom'],
    ['Cross River State', 'Cross River'],
    ['Abuja', 'Federal Capital Territory'],
    ['FCT', 'Federal Capital Territory'],
    ['federal capital territory', 'Federal Capital Territory'],
  ])('maps %j to %j', (input, expected) => {
    expect(canonicalState(input)).toBe(expected);
  });

  it.each(['', 'Atlantis', 'Lagos Island', 'Ghana'])('rejects %j', (input) => {
    expect(canonicalState(input)).toBeNull();
  });
});
