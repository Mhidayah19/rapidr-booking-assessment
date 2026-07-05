import { describe, expect, it } from 'vitest';
import { transition } from './transition';
import type { BookingSnapshot, BookingStatus } from './types';

const NOW = new Date('2026-07-08T10:00:00+08:00');

function snapshot(overrides: Partial<BookingSnapshot> = {}): BookingSnapshot {
  return {
    status: 'pending',
    expiresAt: new Date(NOW.getTime() + 5 * 60_000), // hold has 5 min left
    slotStartsAt: new Date(NOW.getTime() + 60 * 60_000), // slot in 1h
    slotEndsAt: new Date(NOW.getTime() + 90 * 60_000),
    ...overrides,
  };
}

describe('confirm', () => {
  it('pending with live hold → confirmed', () => {
    expect(transition(snapshot(), 'confirm', NOW)).toEqual({ ok: true, next: 'confirmed' });
  });

  it('pending with lapsed hold → HOLD_EXPIRED', () => {
    const b = snapshot({ expiresAt: new Date(NOW.getTime() - 1) });
    expect(transition(b, 'confirm', NOW)).toEqual({ ok: false, code: 'HOLD_EXPIRED' });
  });

  it('hold expiring exactly now → HOLD_EXPIRED (boundary is inclusive)', () => {
    const b = snapshot({ expiresAt: NOW });
    expect(transition(b, 'confirm', NOW)).toEqual({ ok: false, code: 'HOLD_EXPIRED' });
  });

  it.each(['confirmed', 'cancelled', 'completed', 'expired'] as BookingStatus[])(
    '%s → INVALID_TRANSITION',
    (status) => {
      expect(transition(snapshot({ status }), 'confirm', NOW)).toEqual({
        ok: false,
        code: 'INVALID_TRANSITION',
      });
    },
  );
});

describe('cancel', () => {
  it('pending → cancelled (even if hold already lapsed)', () => {
    expect(transition(snapshot(), 'cancel', NOW)).toEqual({ ok: true, next: 'cancelled' });
    const lapsed = snapshot({ expiresAt: new Date(NOW.getTime() - 1) });
    expect(transition(lapsed, 'cancel', NOW)).toEqual({ ok: true, next: 'cancelled' });
  });

  it('confirmed before slot start → cancelled', () => {
    const b = snapshot({ status: 'confirmed', expiresAt: null });
    expect(transition(b, 'cancel', NOW)).toEqual({ ok: true, next: 'cancelled' });
  });

  it('confirmed after slot start → TOO_LATE_TO_CANCEL', () => {
    const b = snapshot({
      status: 'confirmed',
      expiresAt: null,
      slotStartsAt: new Date(NOW.getTime() - 1),
    });
    expect(transition(b, 'cancel', NOW)).toEqual({ ok: false, code: 'TOO_LATE_TO_CANCEL' });
  });

  it.each(['cancelled', 'completed', 'expired'] as BookingStatus[])(
    '%s → INVALID_TRANSITION',
    (status) => {
      expect(transition(snapshot({ status }), 'cancel', NOW)).toEqual({
        ok: false,
        code: 'INVALID_TRANSITION',
      });
    },
  );
});

describe('complete', () => {
  it('confirmed after slot end → completed', () => {
    const b = snapshot({
      status: 'confirmed',
      expiresAt: null,
      slotStartsAt: new Date(NOW.getTime() - 90 * 60_000),
      slotEndsAt: new Date(NOW.getTime() - 60 * 60_000),
    });
    expect(transition(b, 'complete', NOW)).toEqual({ ok: true, next: 'completed' });
  });

  it('confirmed before slot end → TOO_EARLY_TO_COMPLETE', () => {
    const b = snapshot({ status: 'confirmed', expiresAt: null });
    expect(transition(b, 'complete', NOW)).toEqual({ ok: false, code: 'TOO_EARLY_TO_COMPLETE' });
  });

  it.each(['pending', 'cancelled', 'completed', 'expired'] as BookingStatus[])(
    '%s → INVALID_TRANSITION',
    (status) => {
      expect(transition(snapshot({ status }), 'complete', NOW)).toEqual({
        ok: false,
        code: 'INVALID_TRANSITION',
      });
    },
  );
});

describe('expire', () => {
  it('pending with lapsed hold → expired', () => {
    const b = snapshot({ expiresAt: new Date(NOW.getTime() - 1) });
    expect(transition(b, 'expire', NOW)).toEqual({ ok: true, next: 'expired' });
  });

  it('pending with live hold → INVALID_TRANSITION (not yet expirable)', () => {
    expect(transition(snapshot(), 'expire', NOW)).toEqual({
      ok: false,
      code: 'INVALID_TRANSITION',
    });
  });

  it.each(['confirmed', 'cancelled', 'completed', 'expired'] as BookingStatus[])(
    '%s → INVALID_TRANSITION',
    (status) => {
      expect(transition(snapshot({ status }), 'expire', NOW)).toEqual({
        ok: false,
        code: 'INVALID_TRANSITION',
      });
    },
  );
});
