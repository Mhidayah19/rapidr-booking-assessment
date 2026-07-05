import { NextResponse } from 'next/server';

const STATUS_BY_CODE: Record<string, number> = {
  VALIDATION_ERROR: 400,
  MISSING_PATIENT: 401,
  BOOKING_NOT_FOUND: 404,
  SLOT_TAKEN: 409,
  INVALID_TRANSITION: 409,
  HOLD_EXPIRED: 409,
  TOO_LATE_TO_CANCEL: 409,
  TOO_EARLY_TO_COMPLETE: 409,
  CONFLICT: 409,
  SLOT_NOT_FOUND: 422,
  SLOT_IN_PAST: 422,
  UNKNOWN_PATIENT: 422,
};

const MESSAGES: Record<string, string> = {
  VALIDATION_ERROR: 'Request body failed validation.',
  MISSING_PATIENT: 'Provide the x-patient-id header (stands in for auth in this assessment).',
  BOOKING_NOT_FOUND: 'No booking with that id.',
  SLOT_TAKEN: 'This slot was just taken. Pick another slot.',
  INVALID_TRANSITION: 'The booking is not in a state that allows this action.',
  HOLD_EXPIRED: 'The 10-minute hold has lapsed. Book the slot again.',
  TOO_LATE_TO_CANCEL: 'Confirmed bookings cannot be cancelled after the slot starts.',
  TOO_EARLY_TO_COMPLETE: 'A booking can only be completed after the slot ends.',
  CONFLICT: 'The booking changed concurrently. Reload and retry.',
  SLOT_NOT_FOUND: 'No slot with that id.',
  SLOT_IN_PAST: 'This slot is in the past.',
  UNKNOWN_PATIENT: 'No patient with that id.',
};

export function errorResponse(code: string, detail?: string) {
  return NextResponse.json(
    { error: { code, message: detail ?? MESSAGES[code] ?? 'Unexpected error.' } },
    { status: STATUS_BY_CODE[code] ?? 500 },
  );
}

export function requirePatientId(req: Request): string | null {
  return req.headers.get('x-patient-id');
}
