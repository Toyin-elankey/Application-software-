import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { quoteDelivery } from '@/server/delivery/quote';
import { AppError } from '@/server/http/problem';
import { createPrisma } from './helpers';
import { createStore } from './commerce-fixtures';

let db: PrismaClient;

beforeAll(() => {
  db = createPrisma();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('delivery quote', () => {
  it('quotes the fee and estimate label for a covered state, with a formatted amount', async () => {
    const { scope } = await createStore(db, { zoneStates: ['Lagos'], zoneFee: 150000n, threshold: null });
    const quote = await quoteDelivery(db, scope, 'lagos state', 3000000n);
    expect(quote).toMatchObject({ covered: true, state: 'Lagos', feeMinor: 150000n, feeDisplay: '₦1,500.00', freeShipping: false, etaLabel: 'Estimate: 1-2 days' });
  });

  it('says so when no zone covers the state', async () => {
    const { scope } = await createStore(db, { zoneStates: ['Lagos'] });
    expect(await quoteDelivery(db, scope, 'Kano', 1000n)).toEqual({ covered: false, state: 'Kano' });
  });

  it('rejects a name that is not a Nigerian state, before any lookup', async () => {
    const { scope } = await createStore(db);
    await expect(quoteDelivery(db, scope, 'Atlantis', 1000n)).rejects.toBeInstanceOf(AppError);
  });

  it('uses the lowest sortOrder when two active zones cover the same state', async () => {
    const { businessId, scope } = await createStore(db, { zoneStates: ['Lagos'] });
    await db.deliveryZone.create({
      data: { businessId, name: 'Later zone', states: ['Lagos'], feeMinor: 999900n, isActive: true, sortOrder: 5 },
    });
    const quote = await quoteDelivery(db, scope, 'Lagos', 1000n);
    expect(quote.covered && quote.zone.name).toBe('Test zone');
  });

  it('ignores an inactive zone', async () => {
    const { businessId, scope } = await createStore(db, { zoneStates: [] });
    await db.deliveryZone.create({
      data: { businessId, name: 'Switched off', states: ['Oyo'], feeMinor: 100n, isActive: false, sortOrder: 1 },
    });
    expect(await quoteDelivery(db, scope, 'Oyo', 1000n)).toEqual({ covered: false, state: 'Oyo' });
  });

  it('does not use another business zones', async () => {
    const a = await createStore(db, { zoneStates: ['Ogun'] });
    const b = await createStore(db, { zoneStates: [] });
    expect(await quoteDelivery(db, b.scope, 'Ogun', 1000n)).toEqual({ covered: false, state: 'Ogun' });
    expect((await quoteDelivery(db, a.scope, 'Ogun', 1000n)).covered).toBe(true);
  });
});
