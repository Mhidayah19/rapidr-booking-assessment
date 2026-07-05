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

  it('concurrent confirm + cancel: exactly one wins', async () => {
    const booking = await bookedSlot();
    const [confirm, cancel] = await Promise.all([
      transitionBooking({ bookingId: booking.id, event: 'confirm' }),
      transitionBooking({ bookingId: booking.id, event: 'cancel' }),
    ]);
    const outcomes = [confirm, cancel];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    expect(outcomes.filter((r) => !r.ok)).toHaveLength(1);
  });
});
