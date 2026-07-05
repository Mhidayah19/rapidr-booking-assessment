'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Doctor { id: string; name: string; specialty: string }
interface Patient { id: string; name: string }
interface Slot { id: string; starts_at: string; ends_at: string }
interface Booking {
  id: string;
  status: string;
  expires_at: string | null;
  slot: { starts_at: string; ends_at: string; doctor: { name: string } };
}

const timeFmt = new Intl.DateTimeFormat('en-SG', {
  weekday: 'short', day: 'numeric', month: 'short',
  hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Singapore',
});

/** A pending booking whose hold lapsed reads as expired; the DB row is reaped lazily. */
function displayStatus(b: Booking): string {
  if (b.status === 'pending' && b.expires_at && new Date(b.expires_at) < new Date()) {
    return 'expired';
  }
  return b.status;
}

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800',
  confirmed: 'bg-green-100 text-green-800',
  cancelled: 'bg-gray-200 text-gray-600',
  completed: 'bg-blue-100 text-blue-800',
  expired: 'bg-red-100 text-red-700',
};

export function BookingPage() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [patientId, setPatientId] = useState('');
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [doctorId, setDoctorId] = useState('');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [message, setMessage] = useState('');
  // Bumped by actions (book/confirm/cancel) to re-run the load effect below.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    (async () => {
      const [{ patients }, { doctors }] = await Promise.all([
        fetch('/api/patients').then((r) => r.json()),
        fetch('/api/doctors').then((r) => r.json()),
      ]);
      if (!active) return;
      setPatients(patients);
      setPatientId((current) => current || patients[0]?.id || '');
      setDoctors(doctors);
      setDoctorId((current) => current || doctors[0]?.id || '');
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!doctorId && !patientId) return;
    let active = true;
    (async () => {
      if (doctorId) {
        const { slots } = await (await fetch(`/api/doctors/${doctorId}/slots`)).json();
        if (active) setSlots(slots);
      }
      if (patientId) {
        const { bookings } = await (
          await fetch('/api/bookings', { headers: { 'x-patient-id': patientId } })
        ).json();
        if (active) setBookings(bookings);
      }
    })();
    return () => { active = false; };
  }, [doctorId, patientId, reloadKey]);

  async function book(slotId: string) {
    const res = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-patient-id': patientId },
      body: JSON.stringify({ slotId }),
    });
    const json = await res.json();
    setMessage(res.ok ? 'Slot held for 10 minutes — confirm below.' : `${json.error.code}: ${json.error.message}`);
    setReloadKey((k) => k + 1);
  }

  async function act(bookingId: string, action: 'confirm' | 'cancel') {
    const res = await fetch(`/api/bookings/${bookingId}/${action}`, { method: 'POST' });
    const json = await res.json();
    setMessage(res.ok ? `Booking ${json.booking.status}.` : `${json.error.code}: ${json.error.message}`);
    setReloadKey((k) => k + 1);
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">RapiDr — Consultation Booking</h1>
        <p className="text-sm text-gray-500">
          Minimal demo UI. Acting as:{' '}
          <select
            className="rounded border px-2 py-1"
            value={patientId}
            onChange={(e) => setPatientId(e.target.value)}
          >
            {patients.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </p>
      </header>

      {message && <p className="rounded bg-gray-100 px-3 py-2 text-sm">{message}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-3 text-base">
            Available slots for
            <select
              className="rounded border px-2 py-1 font-normal"
              value={doctorId}
              onChange={(e) => setDoctorId(e.target.value)}
            >
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>{d.name} — {d.specialty}</option>
              ))}
            </select>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid max-h-80 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
          {slots.map((s) => (
            <Button key={s.id} variant="outline" size="sm" onClick={() => book(s.id)}>
              {timeFmt.format(new Date(s.starts_at))}
            </Button>
          ))}
          {slots.length === 0 && <p className="col-span-full text-sm text-gray-500">No available slots.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">My bookings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {bookings.map((b) => {
            const status = displayStatus(b);
            return (
              <div key={b.id} className="flex items-center justify-between rounded border px-3 py-2 text-sm">
                <span>
                  {b.slot.doctor.name} · {timeFmt.format(new Date(b.slot.starts_at))}
                </span>
                <span className="flex items-center gap-2">
                  <Badge className={STATUS_STYLE[status]}>{status}</Badge>
                  {status === 'pending' && (
                    <Button size="sm" onClick={() => act(b.id, 'confirm')}>Confirm</Button>
                  )}
                  {(status === 'pending' || status === 'confirmed') && (
                    <Button size="sm" variant="ghost" onClick={() => act(b.id, 'cancel')}>Cancel</Button>
                  )}
                </span>
              </div>
            );
          })}
          {bookings.length === 0 && <p className="text-sm text-gray-500">No bookings yet.</p>}
        </CardContent>
      </Card>
    </main>
  );
}
