export const BOOKING_STATUSES = [
  'pending',
  'confirmed',
  'cancelled',
  'completed',
  'expired',
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export type BookingEvent = 'confirm' | 'cancel' | 'complete' | 'expire';

/** The minimal view of a booking the state machine needs to decide a transition. */
export interface BookingSnapshot {
  status: BookingStatus;
  expiresAt: Date | null; // set while status === 'pending'
  slotStartsAt: Date;
  slotEndsAt: Date;
}

export type TransitionErrorCode =
  | 'INVALID_TRANSITION'
  | 'HOLD_EXPIRED'
  | 'TOO_LATE_TO_CANCEL'
  | 'TOO_EARLY_TO_COMPLETE';

export type TransitionResult =
  | { ok: true; next: BookingStatus }
  | { ok: false; code: TransitionErrorCode };
