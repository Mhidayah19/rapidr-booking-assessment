import { describe, expect, it } from 'vitest';
import { createBooking } from '@/data/bookings';
import { getDb } from '@/data/client';
import { createTestSlot, lapseHold, PATIENTS } from '../helpers';

const patientPool = Object.values(PATIENTS);

describe('double-booking prevention', () => {
  it('exactly one of 20 concurrent bookings for the same slot succeeds', async () => {
    const slotId = await createTestSlot();

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        createBooking({ slotId, patientId: patientPool[i % patientPool.length] }),
      ),
    );

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(19);
    for (const loser of losers) {
      expect(loser).toMatchObject({ ok: false, code: 'SLOT_TAKEN' });
    }

    const { count } = await getDb()
      .from('bookings')
      .select('*', { count: 'exact', head: true })
      .eq('slot_id', slotId)
      .in('status', ['pending', 'confirmed']);
    expect(count).toBe(1);
  });

  it('sequential second booking is rejected while the hold is live', async () => {
    const slotId = await createTestSlot();
    const first = await createBooking({ slotId, patientId: PATIENTS.alice });
    expect(first.ok).toBe(true);

    const second = await createBooking({ slotId, patientId: PATIENTS.ben });
    expect(second).toMatchObject({ ok: false, code: 'SLOT_TAKEN' });
  });
});

describe('expired holds', () => {
  it('a lapsed pending hold is reaped and the slot becomes bookable — exactly one new winner under concurrency', async () => {
    const slotId = await createTestSlot();
    const first = await createBooking({ slotId, patientId: PATIENTS.alice });
    if (!first.ok) throw new Error('setup failed');
    await lapseHold(first.booking.id);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createBooking({ slotId, patientId: patientPool[i % patientPool.length] }),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);

    const { data: reaped } = await getDb()
      .from('bookings')
      .select('status')
      .eq('id', first.booking.id)
      .single();
    expect(reaped?.status).toBe('expired');
  });
});

describe('idempotency', () => {
  it('same patient + same Idempotency-Key returns the existing booking, not a duplicate', async () => {
    const slotId = await createTestSlot();
    const key = crypto.randomUUID();

    const first = await createBooking({ slotId, patientId: PATIENTS.alice, idempotencyKey: key });
    const retry = await createBooking({ slotId, patientId: PATIENTS.alice, idempotencyKey: key });

    if (!first.ok || !retry.ok) throw new Error('expected both calls to succeed');
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.booking.id).toBe(first.booking.id);
  });

  it('concurrent retries with the same key produce exactly one booking', async () => {
    const slotId = await createTestSlot();
    const key = crypto.randomUUID();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        createBooking({ slotId, patientId: PATIENTS.alice, idempotencyKey: key }),
      ),
    );

    const ok = results.filter((r) => r.ok);
    expect(ok).toHaveLength(5); // all resolve to the same booking
    const ids = new Set(ok.map((r) => (r.ok ? r.booking.id : '')));
    expect(ids.size).toBe(1);
  });
});

describe('input guards', () => {
  it('unknown slot → SLOT_NOT_FOUND', async () => {
    const result = await createBooking({
      slotId: crypto.randomUUID(),
      patientId: PATIENTS.alice,
    });
    expect(result).toMatchObject({ ok: false, code: 'SLOT_NOT_FOUND' });
  });

  it('past slot → SLOT_IN_PAST', async () => {
    const slotId = await createTestSlot({
      startsAt: new Date(Date.now() - 60 * 60_000),
      endsAt: new Date(Date.now() - 30 * 60_000),
    });
    const result = await createBooking({ slotId, patientId: PATIENTS.alice });
    expect(result).toMatchObject({ ok: false, code: 'SLOT_IN_PAST' });
  });
});
