import { getDb } from './client';

export const HOLD_MINUTES = 10;

export interface BookingRow {
  id: string;
  slot_id: string;
  patient_id: string;
  status: string;
  expires_at: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

export type CreateBookingError = 'SLOT_TAKEN' | 'SLOT_NOT_FOUND' | 'SLOT_IN_PAST' | 'UNKNOWN_PATIENT';

export type CreateBookingResult =
  | { ok: true; booking: BookingRow; created: boolean }
  | { ok: false; code: CreateBookingError };

export async function createBooking(input: {
  slotId: string;
  patientId: string;
  idempotencyKey?: string;
}): Promise<CreateBookingResult> {
  const db = getDb();

  if (input.idempotencyKey) {
    const existing = await findByIdempotencyKey(input.patientId, input.idempotencyKey);
    if (existing) return { ok: true, booking: existing, created: false };
  }

  const { data: slot, error: slotError } = await db
    .from('slots')
    .select('id, starts_at')
    .eq('id', input.slotId)
    .maybeSingle();
  if (slotError) throw slotError;
  if (!slot) return { ok: false, code: 'SLOT_NOT_FOUND' };
  if (new Date(slot.starts_at) <= new Date()) return { ok: false, code: 'SLOT_IN_PAST' };

  // Reap any lapsed hold BEFORE inserting: an expired-but-unreaped pending row
  // still occupies the one_active_booking_per_slot index. Ordering matters —
  // see spec §5. No transaction needed across the two statements: each is
  // atomic and the unique index stays the single arbiter; the worst race
  // outcome is a spurious SLOT_TAKEN, never a double-booking.
  const nowIso = new Date().toISOString();
  const { error: reapError } = await db
    .from('bookings')
    .update({ status: 'expired', updated_at: nowIso })
    .eq('slot_id', input.slotId)
    .eq('status', 'pending')
    .lt('expires_at', nowIso);
  if (reapError) throw reapError;

  const { data: created, error: insertError } = await db
    .from('bookings')
    .insert({
      slot_id: input.slotId,
      patient_id: input.patientId,
      status: 'pending',
      expires_at: new Date(Date.now() + HOLD_MINUTES * 60_000).toISOString(),
      idempotency_key: input.idempotencyKey ?? null,
    })
    .select('*')
    .single();

  if (insertError) {
    if (insertError.code === '23505') {
      // Unique violation: either the slot index (lost the race) or the
      // idempotency key (concurrent retry). Re-checking the key disambiguates.
      if (input.idempotencyKey) {
        const existing = await findByIdempotencyKey(input.patientId, input.idempotencyKey);
        if (existing) return { ok: true, booking: existing, created: false };
      }
      return { ok: false, code: 'SLOT_TAKEN' };
    }
    if (insertError.code === '23503') return { ok: false, code: 'UNKNOWN_PATIENT' };
    throw insertError;
  }

  return { ok: true, booking: created, created: true };
}

async function findByIdempotencyKey(
  patientId: string,
  key: string,
): Promise<BookingRow | null> {
  const { data, error } = await getDb()
    .from('bookings')
    .select('*')
    .eq('patient_id', patientId)
    .eq('idempotency_key', key)
    .maybeSingle();
  if (error) throw error;
  return data;
}
