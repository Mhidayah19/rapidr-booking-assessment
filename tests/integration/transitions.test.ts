import { describe, expect, it } from 'vitest';
import { createBooking, transitionBooking } from '@/data/bookings';
import { createTestSlot, lapseHold, PATIENTS } from '../helpers';

async function bookedSlot() {
  const slotId = await createTestSlot();
  const result = await createBooking({ slotId, patientId: PATIENTS.alice });
  if (!result.ok) throw new Error('setup failed');
  return result.booking;
}

describe('transitionBooking', () => {
  it('confirm a live hold → confirmed', async () => {
    const booking = await bookedSlot();
    const result = await transitionBooking({ bookingId: booking.id, event: 'confirm' });
    expect(result).toMatchObject({ ok: true, booking: { status: 'confirmed' } });
  });

  it('confirm a lapsed hold → HOLD_EXPIRED', async () => {
    const booking = await bookedSlot();
    await lapseHold(booking.id);
    const result = await transitionBooking({ bookingId: booking.id, event: 'confirm' });
    expect(result).toMatchObject({ ok: false, code: 'HOLD_EXPIRED' });
  });

  it('cancel then confirm → INVALID_TRANSITION', async () => {
    const booking = await bookedSlot();
    await transitionBooking({ bookingId: booking.id, event: 'cancel' });
    const result = await transitionBooking({ bookingId: booking.id, event: 'confirm' });
    expect(result).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
  });

  it('complete before slot end → TOO_EARLY_TO_COMPLETE', async () => {
    const booking = await bookedSlot();
    await transitionBooking({ bookingId: booking.id, event: 'confirm' });
    const result = await transitionBooking({ bookingId: booking.id, event: 'complete' });
    expect(result).toMatchObject({ ok: false, code: 'TOO_EARLY_TO_COMPLETE' });
  });

  it('unknown booking → BOOKING_NOT_FOUND', async () => {
    const result = await transitionBooking({ bookingId: crypto.randomUUID(), event: 'cancel' });
    expect(result).toMatchObject({ ok: false, code: 'BOOKING_NOT_FOUND' });
  });

  // Two concurrent *confirms* is a genuine mutually-exclusive conflict: confirm is
  // only valid from `pending`, so at most one can ever apply. (confirm + cancel is
  // NOT such a conflict — cancel is valid from `confirmed` too, so an interleaved
  // pending→confirmed→cancelled is a legal sequence, not a lost update.)
  it('concurrent duplicate confirms: exactly one applies (optimistic concurrency)', async () => {
    const booking = await bookedSlot();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        transitionBooking({ bookingId: booking.id, event: 'confirm' }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    // Losers are rejected either by the conditional UPDATE (CONFLICT, true race)
    // or by the state machine reading the already-confirmed row (INVALID_TRANSITION).
    for (const loser of results.filter((r) => !r.ok)) {
      expect(loser.ok).toBe(false);
      if (!loser.ok) expect(['CONFLICT', 'INVALID_TRANSITION']).toContain(loser.code);
    }
  });
});
