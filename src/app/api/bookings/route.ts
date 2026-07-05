import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createBooking } from '@/data/bookings';
import { listBookingsForPatient } from '@/data/catalog';
import { errorResponse, requirePatientId } from '@/lib/api';

const bodySchema = z.object({ slotId: z.guid() });

export async function POST(req: Request) {
  const patientId = requirePatientId(req);
  if (!patientId) return errorResponse('MISSING_PATIENT');

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return errorResponse('VALIDATION_ERROR');

  const result = await createBooking({
    slotId: parsed.data.slotId,
    patientId,
    idempotencyKey: req.headers.get('idempotency-key') ?? undefined,
  });
  if (!result.ok) return errorResponse(result.code);

  return NextResponse.json({ booking: result.booking }, { status: result.created ? 201 : 200 });
}

export async function GET(req: Request) {
  const patientId = requirePatientId(req);
  if (!patientId) return errorResponse('MISSING_PATIENT');
  return NextResponse.json({ bookings: await listBookingsForPatient(patientId) });
}
