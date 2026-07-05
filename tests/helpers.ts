import { getDb } from '@/data/client';

export const PATIENTS = {
  alice: '00000000-0000-0000-0000-0000000000a1',
  ben: '00000000-0000-0000-0000-0000000000a2',
  chitra: '00000000-0000-0000-0000-0000000000a3',
} as const;

/** Inserts a dedicated doctor + one future slot; returns the slot id. */
export async function createTestSlot(
  overrides: { startsAt?: Date; endsAt?: Date } = {},
): Promise<string> {
  const db = getDb();
  const startsAt = overrides.startsAt ?? new Date(Date.now() + 24 * 60 * 60_000);
  const endsAt = overrides.endsAt ?? new Date(startsAt.getTime() + 30 * 60_000);

  const { data: doctor, error: doctorError } = await db
    .from('doctors')
    .insert({ name: 'Test Doctor', specialty: 'Testing' })
    .select('id')
    .single();
  if (doctorError) throw doctorError;

  const { data: slot, error: slotError } = await db
    .from('slots')
    .insert({
      doctor_id: doctor.id,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
    })
    .select('id')
    .single();
  if (slotError) throw slotError;

  return slot.id;
}

/** Force a booking's hold into the past — simulates the 10 minutes elapsing. */
export async function lapseHold(bookingId: string): Promise<void> {
  const { error } = await getDb()
    .from('bookings')
    .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
    .eq('id', bookingId);
  if (error) throw error;
}
