import { getDb } from './client';
import type { BookingRow } from './bookings';

export async function listDoctors() {
  const { data, error } = await getDb().from('doctors').select('*').order('name');
  if (error) throw error;
  return data;
}

export async function listPatients() {
  const { data, error } = await getDb().from('patients').select('id, name').order('name');
  if (error) throw error;
  return data;
}

export async function listAvailableSlots(doctorId: string) {
  const { data, error } = await getDb()
    .from('available_slots')
    .select('*')
    .eq('doctor_id', doctorId)
    .order('starts_at')
    .limit(200);
  if (error) throw error;
  return data;
}

export interface PatientBooking extends BookingRow {
  slot: { starts_at: string; ends_at: string; doctor: { name: string; specialty: string } };
}

export async function listBookingsForPatient(patientId: string): Promise<PatientBooking[]> {
  const { data, error } = await getDb()
    .from('bookings')
    .select('*, slot:slots(starts_at, ends_at, doctor:doctors(name, specialty))')
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data as unknown as PatientBooking[];
}
