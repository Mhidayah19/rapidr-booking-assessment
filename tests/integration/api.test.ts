import { describe, expect, it } from 'vitest';
import { POST as createBookingRoute } from '@/app/api/bookings/route';
import { POST as confirmRoute } from '@/app/api/bookings/[id]/confirm/route';
import { GET as slotsRoute } from '@/app/api/doctors/[id]/slots/route';
import { createTestSlot, PATIENTS } from '../helpers';

const SEED_DOCTOR = '00000000-0000-0000-0000-0000000000d1';

describe('GET /api/doctors/:id/slots', () => {
  it('accepts a seed doctor id (sentinel UUID, non-RFC version bits) → 200', async () => {
    const res = await slotsRoute(
      new Request(`http://localhost/api/doctors/${SEED_DOCTOR}/slots`),
      { params: Promise.resolve({ id: SEED_DOCTOR }) },
    );
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).slots)).toBe(true);
  });

  it('rejects a non-UUID id → 400', async () => {
    const res = await slotsRoute(new Request('http://localhost/api/doctors/nope/slots'), {
      params: Promise.resolve({ id: 'nope' }),
    });
    expect(res.status).toBe(400);
  });
});

function bookingRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/bookings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /api/bookings', () => {
  it('books a slot → 201 with pending booking', async () => {
    const slotId = await createTestSlot();
    const res = await createBookingRoute(
      bookingRequest({ slotId }, { 'x-patient-id': PATIENTS.alice }),
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.booking.status).toBe('pending');
  });

  it('missing x-patient-id → 401', async () => {
    const res = await createBookingRoute(bookingRequest({ slotId: crypto.randomUUID() }));
    expect(res.status).toBe(401);
  });

  it('malformed body → 400 VALIDATION_ERROR', async () => {
    const res = await createBookingRoute(
      bookingRequest({ slotId: 'not-a-uuid' }, { 'x-patient-id': PATIENTS.alice }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('VALIDATION_ERROR');
  });

  it('taken slot → 409 SLOT_TAKEN', async () => {
    const slotId = await createTestSlot();
    await createBookingRoute(bookingRequest({ slotId }, { 'x-patient-id': PATIENTS.alice }));
    const res = await createBookingRoute(
      bookingRequest({ slotId }, { 'x-patient-id': PATIENTS.ben }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe('SLOT_TAKEN');
  });

  it('idempotent retry → 200 with the same booking', async () => {
    const slotId = await createTestSlot();
    const key = crypto.randomUUID();
    const first = await createBookingRoute(
      bookingRequest({ slotId }, { 'x-patient-id': PATIENTS.alice, 'idempotency-key': key }),
    );
    const retry = await createBookingRoute(
      bookingRequest({ slotId }, { 'x-patient-id': PATIENTS.alice, 'idempotency-key': key }),
    );
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect((await retry.json()).booking.id).toBe((await first.json()).booking.id);
  });
});

describe('POST /api/bookings/:id/confirm', () => {
  it('confirms a pending booking → 200', async () => {
    const slotId = await createTestSlot();
    const created = await createBookingRoute(
      bookingRequest({ slotId }, { 'x-patient-id': PATIENTS.alice }),
    );
    const { booking } = await created.json();

    const res = await confirmRoute(
      new Request(`http://localhost/api/bookings/${booking.id}/confirm`, { method: 'POST' }),
      { params: Promise.resolve({ id: booking.id }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).booking.status).toBe('confirmed');
  });

  it('unknown booking → 404', async () => {
    const id = crypto.randomUUID();
    const res = await confirmRoute(
      new Request(`http://localhost/api/bookings/${id}/confirm`, { method: 'POST' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(404);
  });
});
