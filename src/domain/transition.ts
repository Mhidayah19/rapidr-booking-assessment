import type { BookingEvent, BookingSnapshot, TransitionResult } from './types';

const invalid = { ok: false, code: 'INVALID_TRANSITION' } as const;

/**
 * Pure booking state machine. The single source of truth for which
 * transitions are legal; persistence applies the result with a
 * conditional UPDATE (optimistic concurrency) in the data layer.
 */
export function transition(
  booking: BookingSnapshot,
  event: BookingEvent,
  now: Date,
): TransitionResult {
  switch (event) {
    case 'confirm': {
      if (booking.status !== 'pending') return invalid;
      if (booking.expiresAt && now >= booking.expiresAt) {
        return { ok: false, code: 'HOLD_EXPIRED' };
      }
      return { ok: true, next: 'confirmed' };
    }
    case 'cancel': {
      if (booking.status === 'pending') return { ok: true, next: 'cancelled' };
      if (booking.status === 'confirmed') {
        if (now >= booking.slotStartsAt) return { ok: false, code: 'TOO_LATE_TO_CANCEL' };
        return { ok: true, next: 'cancelled' };
      }
      return invalid;
    }
    case 'complete': {
      if (booking.status !== 'confirmed') return invalid;
      if (now < booking.slotEndsAt) return { ok: false, code: 'TOO_EARLY_TO_COMPLETE' };
      return { ok: true, next: 'completed' };
    }
    case 'expire': {
      if (booking.status !== 'pending') return invalid;
      if (booking.expiresAt && now < booking.expiresAt) return invalid;
      return { ok: true, next: 'expired' };
    }
  }
}
