# Consultation Booking System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the RapiDr take-home booking system per `docs/specs/2026-07-06-booking-system-design.md` — DB-enforced double-booking prevention, explicit state machine, race-condition tests, minimal UI, deployed.

**Architecture:** Next.js App Router (TypeScript) with three layers: `src/domain` (pure state machine, zero I/O), `src/data` (Supabase adapters), `src/app/api` (thin Zod-validated route handlers). Postgres owns the invariants: partial unique index `one_active_booking_per_slot` prevents double-booking; conditional UPDATEs give optimistic concurrency on transitions.

**Tech Stack:** Next.js, TypeScript, Supabase (Postgres, local CLI + cloud), `@supabase/supabase-js`, Zod, Vitest, Tailwind + shadcn/ui, Vercel.

**Delivery flow:** 6 squash-merged PRs (see spec §10). Each task below ends in a commit; PR tasks push the branch and open/merge the PR with a decision-recording description.

**Conventions used throughout:**
- Package manager: `pnpm`.
- Local Supabase: `supabase start` must be running for integration tests (`tests/`). Unit tests (`src/**/*.test.ts`) need nothing.
- Env vars (committed per the brief's instruction): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` (app) and `.env.test` (tests → local Supabase).

---

## PR1 — Scaffold & schema (branch: `feat/scaffold-and-schema`)

### Task 1: GitHub repo + branch

**Files:** none (git/GitHub only)

- [ ] **Step 1.1:** Create the public GitHub repo from the existing local repo (spec doc is already committed on `main`):

```bash
cd /Users/hid/Developer/rapidr-booking-assessment
gh repo create rapidr-booking-assessment --public --source=. --push
```

Expected: repo created, `main` pushed with the spec commit.

- [ ] **Step 1.2:** Create the PR1 branch:

```bash
git checkout -b feat/scaffold-and-schema
```

### Task 2: Next.js scaffold

**Files:** Create: entire Next.js app skeleton (`package.json`, `src/app/*`, `tsconfig.json`, `next.config.ts`, `.gitignore`, Tailwind config)

- [ ] **Step 2.1:** Scaffold in a temp dir (create-next-app refuses non-empty dirs), then move into the repo:

```bash
cd /private/tmp/claude-501/-Users-hid-Developer-rapidr-booking-assessment/c3920d3b-9254-41c6-9e64-a1b2a091975d/scratchpad
pnpm create next-app@latest rapidr-scaffold --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --no-turbopack
rsync -a --exclude=node_modules --exclude=.git rapidr-scaffold/ /Users/hid/Developer/rapidr-booking-assessment/
cd /Users/hid/Developer/rapidr-booking-assessment && pnpm install
```

- [ ] **Step 2.2:** Edit `.gitignore` — the Next default ignores `.env*`, but the brief explicitly asks for committed env vars. Replace the env section with:

```gitignore
# env — committed intentionally per assessment instructions (throwaway credentials only)
!.env.local
!.env.test
```

(Keep the rest of the generated `.gitignore` as-is.)

- [ ] **Step 2.3:** Add runtime/test deps:

```bash
pnpm add @supabase/supabase-js zod
pnpm add -D vitest dotenv
```

- [ ] **Step 2.4:** Add test scripts to `package.json` `"scripts"`:

```json
"test": "vitest run",
"test:unit": "vitest run src",
"test:integration": "vitest run tests"
```

- [ ] **Step 2.5:** Create `vitest.config.ts` at repo root:

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    setupFiles: ['tests/setup.ts'],
  },
});
```

- [ ] **Step 2.6:** Create `tests/setup.ts`:

```ts
import { config } from 'dotenv';

config({ path: '.env.test' });
```

- [ ] **Step 2.7:** Verify the app boots (`pnpm dev`, open http://localhost:3000, then stop it), then commit:

```bash
git add -A
git commit -m "chore: scaffold Next.js app with Vitest and Zod

.gitignore deliberately un-ignores .env.local/.env.test — the brief
asks for committed env vars (throwaway credentials only)."
```

### Task 3: Supabase local project, migration, seed

**Files:**
- Create: `supabase/config.toml` (generated), `supabase/migrations/20260706120000_booking_schema.sql`, `supabase/seed.sql`, `.env.local`, `.env.test`

- [ ] **Step 3.1:** Init and start local Supabase:

```bash
supabase init
supabase start
```

Expected: containers start; `supabase status` prints API URL (`http://127.0.0.1:54321`) and `service_role` key.

- [ ] **Step 3.2:** Create `supabase/migrations/20260706120000_booking_schema.sql`:

```sql
create type booking_status as enum ('pending', 'confirmed', 'cancelled', 'completed', 'expired');

create table doctors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  specialty text not null
);

create table patients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique
);

create table slots (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references doctors (id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  unique (doctor_id, starts_at),
  check (ends_at > starts_at)
);

create table bookings (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references slots (id),
  patient_id uuid not null references patients (id),
  status booking_status not null default 'pending',
  expires_at timestamptz,
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (patient_id, idempotency_key)
);

-- The double-booking guarantee: at most one ACTIVE booking per slot,
-- enforced by the storage layer regardless of how many app instances race.
create unique index one_active_booking_per_slot
  on bookings (slot_id)
  where status in ('pending', 'confirmed');

create index bookings_patient_idx on bookings (patient_id, created_at desc);

-- A slot is available if it is in the future and has no live hold or confirmation.
-- Expired-but-unreaped pending rows count as free here; the booking flow reaps
-- them before inserting (see data layer) so the partial index never blocks a
-- slot this view advertises.
create view available_slots as
select s.*
from slots s
where s.starts_at > now()
  and not exists (
    select 1 from bookings b
    where b.slot_id = s.id
      and (
        b.status = 'confirmed'
        or (b.status = 'pending' and b.expires_at > now())
      )
  );
```

- [ ] **Step 3.3:** Create `supabase/seed.sql` (fixed UUIDs so the UI/tests/README can reference them):

```sql
insert into doctors (id, name, specialty) values
  ('00000000-0000-0000-0000-0000000000d1', 'Dr. Tan Wei Ming', 'General Practice'),
  ('00000000-0000-0000-0000-0000000000d2', 'Dr. Sarah Lim', 'Dermatology'),
  ('00000000-0000-0000-0000-0000000000d3', 'Dr. Rajesh Kumar', 'Cardiology');

insert into patients (id, name, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'Alice Wong', 'alice@example.com'),
  ('00000000-0000-0000-0000-0000000000a2', 'Ben Ng', 'ben@example.com'),
  ('00000000-0000-0000-0000-0000000000a3', 'Chitra Devi', 'chitra@example.com');

-- 30-minute slots, 09:00–17:00 SGT, for the next 14 days, per doctor.
insert into slots (doctor_id, starts_at, ends_at)
select d.id, ts, ts + interval '30 minutes'
from doctors d
cross join generate_series(
  date_trunc('day', now() at time zone 'Asia/Singapore') + interval '1 day',
  date_trunc('day', now() at time zone 'Asia/Singapore') + interval '14 days',
  interval '30 minutes'
) as ts_local(ts_sgt)
cross join lateral (select ts_local.ts_sgt at time zone 'Asia/Singapore' as ts) t
where extract(hour from ts_local.ts_sgt) between 9 and 16;
```

- [ ] **Step 3.4:** Apply and verify:

```bash
supabase db reset
```

Expected: migration + seed run clean. Verify counts:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "select (select count(*) from doctors) doctors, (select count(*) from slots) slots, (select count(*) from available_slots) available;"
```

Expected: 3 doctors, >1000 slots, available = slots (nothing booked yet).

- [ ] **Step 3.5:** Prove the index does its job before writing any app code:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "
insert into bookings (slot_id, patient_id, status, expires_at)
select id, '00000000-0000-0000-0000-0000000000a1', 'pending', now() + interval '10 minutes' from slots limit 1;
insert into bookings (slot_id, patient_id, status, expires_at)
select id, '00000000-0000-0000-0000-0000000000a2', 'pending', now() + interval '10 minutes' from slots limit 1;"
```

Expected: second insert fails with `duplicate key value violates unique constraint "one_active_booking_per_slot"`. Then clean up:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "truncate bookings;"
```

- [ ] **Step 3.6:** Create `.env.local` and `.env.test`, both with the local values for now (`supabase status` shows the service_role key; `.env.local` gets swapped to cloud values in PR6):

```bash
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=<service_role key from `supabase status`>
```

- [ ] **Step 3.7:** Commit:

```bash
git add -A
git commit -m "feat: booking schema — partial unique index carries the double-booking guarantee

one_active_booking_per_slot (slot_id WHERE status IN pending,confirmed)
makes check-then-insert races impossible at the storage layer.
available_slots view treats lapsed pending holds as free; the booking
flow reaps them before insert so view and index never disagree."
```

### Task 4: Open & merge PR1

- [ ] **Step 4.1:**

```bash
git push -u origin feat/scaffold-and-schema
gh pr create --title "Scaffold & schema: DB-enforced booking invariants" --body "## What
Next.js scaffold (TS, Tailwind, Vitest) + Supabase local setup with the full schema and seed.

## Key decision
Double-booking is prevented by a **partial unique index** (\`one_active_booking_per_slot\`), not application-level checks — correct under any concurrency, across any number of serverless instances. Verified manually via two conflicting inserts before writing app code (see commit).

## Also
- \`.env.*\` committed intentionally per the brief (throwaway local credentials).
- \`available_slots\` view defines availability in one place; interaction with lazy hold expiry documented in the migration."
gh pr merge --squash --delete-branch
git checkout main && git pull
```

---

## PR2 — Domain state machine (branch: `feat/domain-state-machine`)

### Task 5: Domain types + pure transition function (TDD)

**Files:**
- Create: `src/domain/types.ts`, `src/domain/transition.ts`
- Test: `src/domain/transition.test.ts`

- [ ] **Step 5.1:** Create branch:

```bash
git checkout -b feat/domain-state-machine
```

- [ ] **Step 5.2:** Create `src/domain/types.ts`:

```ts
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
```

- [ ] **Step 5.3:** Write the failing test `src/domain/transition.test.ts` — the full transition table from spec §5, plus guards and boundaries:

```ts
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
```

- [ ] **Step 5.4:** Run and verify it fails:

```bash
pnpm test:unit
```

Expected: FAIL — `transition` not found.

- [ ] **Step 5.5:** Implement `src/domain/transition.ts`:

```ts
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
```

- [ ] **Step 5.6:** Run and verify all pass:

```bash
pnpm test:unit
```

Expected: PASS (all transition-table cases green).

- [ ] **Step 5.7:** Commit:

```bash
git add src/domain vitest.config.ts
git commit -m "feat: pure booking state machine with exhaustive transition tests

No I/O — decides transitions from a snapshot + clock, so every row of
the transition table (incl. guard boundaries) is unit-testable."
```

### Task 6: Open & merge PR2

- [ ] **Step 6.1:**

```bash
git push -u origin feat/domain-state-machine
gh pr create --title "Domain: booking state machine (pure, exhaustively tested)" --body "## What
\`transition(booking, event, now)\` — the single source of truth for legal booking transitions (spec §5 table), as a pure function.

## Why pure
Testable with zero DB (every table row + boundary conditions covered), and the clock is a parameter — no time-dependent flakiness. The data layer (next PR) applies results via conditional UPDATE so concurrent transitions can't corrupt state."
gh pr merge --squash --delete-branch
git checkout main && git pull
```

---

## PR3 — Booking creation + race tests (branch: `feat/booking-creation`)

### Task 7: Data client + test helpers

**Files:**
- Create: `src/data/client.ts`, `tests/helpers.ts`

- [ ] **Step 7.1:** Create branch:

```bash
git checkout -b feat/booking-creation
```

- [ ] **Step 7.2:** Create `src/data/client.ts`:

```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | undefined;

/**
 * Server-side Supabase client (service role). Only ever imported from
 * route handlers and the data layer — never shipped to the browser.
 */
export function getDb(): SupabaseClient {
  client ??= createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  );
  return client;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
```

- [ ] **Step 7.3:** Create `tests/helpers.ts` — every integration test gets a fresh doctor+slot so tests are independent and parallel-safe:

```ts
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
```

### Task 8: `createBooking` — reap → insert → 409 mapping, idempotency (TDD)

**Files:**
- Create: `src/data/bookings.ts`
- Test: `tests/integration/booking-race.test.ts`

- [ ] **Step 8.1:** Write the failing tests `tests/integration/booking-race.test.ts` — this file is the centerpiece of the submission:

```ts
import { describe, expect, it } from 'vitest';
import { createBooking } from '@/data/bookings';
import { getDb } from '@/data/client';
import { createTestSlot, lapseHold, PATIENTS } from '../helpers';

const patientPool = Object.values(PATIENTS);

describe('double-booking prevention', () => {
  it('exactly one of 20 concurrent bookings for the same slot succeeds', async () => {
    const slotId = await createTestSlot();

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        createBooking({ slotId, patientId: patientPool[i % patientPool.length] }),
      ),
    );

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(19);
    for (const loser of losers) {
      expect(loser).toMatchObject({ ok: false, code: 'SLOT_TAKEN' });
    }

    const { count } = await getDb()
      .from('bookings')
      .select('*', { count: 'exact', head: true })
      .eq('slot_id', slotId)
      .in('status', ['pending', 'confirmed']);
    expect(count).toBe(1);
  });

  it('sequential second booking is rejected while the hold is live', async () => {
    const slotId = await createTestSlot();
    const first = await createBooking({ slotId, patientId: PATIENTS.alice });
    expect(first.ok).toBe(true);

    const second = await createBooking({ slotId, patientId: PATIENTS.ben });
    expect(second).toMatchObject({ ok: false, code: 'SLOT_TAKEN' });
  });
});

describe('expired holds', () => {
  it('a lapsed pending hold is reaped and the slot becomes bookable — exactly one new winner under concurrency', async () => {
    const slotId = await createTestSlot();
    const first = await createBooking({ slotId, patientId: PATIENTS.alice });
    if (!first.ok) throw new Error('setup failed');
    await lapseHold(first.booking.id);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createBooking({ slotId, patientId: patientPool[i % patientPool.length] }),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);

    const { data: reaped } = await getDb()
      .from('bookings')
      .select('status')
      .eq('id', first.booking.id)
      .single();
    expect(reaped?.status).toBe('expired');
  });
});

describe('idempotency', () => {
  it('same patient + same Idempotency-Key returns the existing booking, not a duplicate', async () => {
    const slotId = await createTestSlot();
    const key = crypto.randomUUID();

    const first = await createBooking({ slotId, patientId: PATIENTS.alice, idempotencyKey: key });
    const retry = await createBooking({ slotId, patientId: PATIENTS.alice, idempotencyKey: key });

    if (!first.ok || !retry.ok) throw new Error('expected both calls to succeed');
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.booking.id).toBe(first.booking.id);
  });

  it('concurrent retries with the same key produce exactly one booking', async () => {
    const slotId = await createTestSlot();
    const key = crypto.randomUUID();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        createBooking({ slotId, patientId: PATIENTS.alice, idempotencyKey: key }),
      ),
    );

    const ok = results.filter((r) => r.ok);
    expect(ok).toHaveLength(5); // all resolve to the same booking
    const ids = new Set(ok.map((r) => (r.ok ? r.booking.id : '')));
    expect(ids.size).toBe(1);
  });
});

describe('input guards', () => {
  it('unknown slot → SLOT_NOT_FOUND', async () => {
    const result = await createBooking({
      slotId: crypto.randomUUID(),
      patientId: PATIENTS.alice,
    });
    expect(result).toMatchObject({ ok: false, code: 'SLOT_NOT_FOUND' });
  });

  it('past slot → SLOT_IN_PAST', async () => {
    const slotId = await createTestSlot({
      startsAt: new Date(Date.now() - 60 * 60_000),
      endsAt: new Date(Date.now() - 30 * 60_000),
    });
    const result = await createBooking({ slotId, patientId: PATIENTS.alice });
    expect(result).toMatchObject({ ok: false, code: 'SLOT_IN_PAST' });
  });
});
```

- [ ] **Step 8.2:** Run to verify failure:

```bash
pnpm test:integration
```

Expected: FAIL — `@/data/bookings` does not exist.

- [ ] **Step 8.3:** Implement `src/data/bookings.ts`:

```ts
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
```

- [ ] **Step 8.4:** Run (local Supabase must be up):

```bash
pnpm test:integration
```

Expected: PASS — all race, expiry, idempotency, and guard tests green.

- [ ] **Step 8.5:** Commit:

```bash
git add src/data tests
git commit -m "feat: booking creation — reap lapsed hold, insert, map 23505 to SLOT_TAKEN

Race tests prove exactly-one-winner under 20 concurrent requests,
rebooking after hold expiry, and idempotent retries (incl. concurrent
retries disambiguated from slot conflicts on the same error code)."
```

### Task 9: Open & merge PR3

- [ ] **Step 9.1:**

```bash
git push -u origin feat/booking-creation
gh pr create --title "Booking creation with race-condition test suite" --body "## What
\`createBooking\`: idempotency check → slot guards → reap lapsed hold → insert → map unique-violation to 409 semantics.

## The correctness argument
No check-then-insert anywhere. The partial unique index is the only arbiter; app code just interprets its verdict. Reap-before-insert ordering documented in-code (an unreaped lapsed hold still occupies the index).

## Tests (the bonus rubric item)
- 20 concurrent bookings → exactly 1 winner, 19× SLOT_TAKEN, 1 active row
- lapsed hold → reaped + exactly one new winner under a 10-way race
- idempotent retry (sequential + concurrent) → one booking
- unknown/past slot guards"
gh pr merge --squash --delete-branch
git checkout main && git pull
```

---

## PR4 — Transitions, listings, API routes (branch: `feat/api-routes`)

### Task 10: `transitionBooking` with optimistic concurrency (TDD)

**Files:**
- Modify: `src/data/bookings.ts` (append)
- Test: `tests/integration/transitions.test.ts`

- [ ] **Step 10.1:** Create branch:

```bash
git checkout -b feat/api-routes
```

- [ ] **Step 10.2:** Write failing tests `tests/integration/transitions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createBooking, transitionBooking } from '@/data/bookings';
import { createTestSlot, lapseHold, PATIENTS } from '../helpers';

async function bookedSlot() {
  const slotId = await createTestSlot();
  const result = await createBooking({ slotId, patientId: PATIENTS.alice });
  if (!result.ok) throw new Error('setup failed');
  return result.booking;
}

describe('transitionBooking', () => {
  it('confirm a live hold → confirmed', async () => {
    const booking = await bookedSlot();
    const result = await transitionBooking({ bookingId: booking.id, event: 'confirm' });
    expect(result).toMatchObject({ ok: true, booking: { status: 'confirmed' } });
  });

  it('confirm a lapsed hold → HOLD_EXPIRED', async () => {
    const booking = await bookedSlot();
    await lapseHold(booking.id);
    const result = await transitionBooking({ bookingId: booking.id, event: 'confirm' });
    expect(result).toMatchObject({ ok: false, code: 'HOLD_EXPIRED' });
  });

  it('cancel then confirm → INVALID_TRANSITION', async () => {
    const booking = await bookedSlot();
    await transitionBooking({ bookingId: booking.id, event: 'cancel' });
    const result = await transitionBooking({ bookingId: booking.id, event: 'confirm' });
    expect(result).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
  });

  it('complete before slot end → TOO_EARLY_TO_COMPLETE', async () => {
    const booking = await bookedSlot();
    await transitionBooking({ bookingId: booking.id, event: 'confirm' });
    const result = await transitionBooking({ bookingId: booking.id, event: 'complete' });
    expect(result).toMatchObject({ ok: false, code: 'TOO_EARLY_TO_COMPLETE' });
  });

  it('unknown booking → BOOKING_NOT_FOUND', async () => {
    const result = await transitionBooking({ bookingId: crypto.randomUUID(), event: 'cancel' });
    expect(result).toMatchObject({ ok: false, code: 'BOOKING_NOT_FOUND' });
  });

  it('concurrent confirm + cancel: exactly one wins', async () => {
    const booking = await bookedSlot();
    const [confirm, cancel] = await Promise.all([
      transitionBooking({ bookingId: booking.id, event: 'confirm' }),
      transitionBooking({ bookingId: booking.id, event: 'cancel' }),
    ]);
    const outcomes = [confirm, cancel];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    expect(outcomes.filter((r) => !r.ok)).toHaveLength(1);
  });
});
```

- [ ] **Step 10.3:** Run to verify failure:

```bash
pnpm test:integration
```

Expected: FAIL — `transitionBooking` not exported.

- [ ] **Step 10.4:** Append to `src/data/bookings.ts`:

```ts
import { transition } from '@/domain/transition';
import type { TransitionErrorCode } from '@/domain/types';
// (merge these imports with the file's existing imports at the top)

export type TransitionBookingError = TransitionErrorCode | 'BOOKING_NOT_FOUND' | 'CONFLICT';

export type TransitionBookingResult =
  | { ok: true; booking: BookingRow }
  | { ok: false; code: TransitionBookingError };

export async function transitionBooking(input: {
  bookingId: string;
  event: 'confirm' | 'cancel' | 'complete';
}): Promise<TransitionBookingResult> {
  const db = getDb();

  const { data: row, error: readError } = await db
    .from('bookings')
    .select('*, slot:slots(starts_at, ends_at)')
    .eq('id', input.bookingId)
    .maybeSingle();
  if (readError) throw readError;
  if (!row) return { ok: false, code: 'BOOKING_NOT_FOUND' };

  const decision = transition(
    {
      status: row.status,
      expiresAt: row.expires_at ? new Date(row.expires_at) : null,
      slotStartsAt: new Date(row.slot.starts_at),
      slotEndsAt: new Date(row.slot.ends_at),
    },
    input.event,
    new Date(),
  );
  if (!decision.ok) return decision;

  // Optimistic concurrency: only apply if the status is still what we decided
  // from. A concurrent transition means zero rows match → CONFLICT.
  const { data: updated, error: updateError } = await db
    .from('bookings')
    .update({ status: decision.next, updated_at: new Date().toISOString() })
    .eq('id', input.bookingId)
    .eq('status', row.status)
    .select('*')
    .maybeSingle();
  if (updateError) throw updateError;
  if (!updated) return { ok: false, code: 'CONFLICT' };

  return { ok: true, booking: updated };
}
```

- [ ] **Step 10.5:** Run and verify all pass:

```bash
pnpm test:integration
```

Expected: PASS.

- [ ] **Step 10.6:** Commit:

```bash
git add src/data/bookings.ts tests/integration/transitions.test.ts
git commit -m "feat: booking transitions via domain decision + conditional UPDATE

Read → pure transition() decides → UPDATE WHERE status = expected.
Zero rows updated = concurrent writer won = 409 CONFLICT; state can
never be corrupted by racing transitions."
```

### Task 11: Listing queries

**Files:**
- Create: `src/data/catalog.ts`

- [ ] **Step 11.1:** Create `src/data/catalog.ts` (read-only queries; the `available_slots` view carries the availability logic):

```ts
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
  return data as PatientBooking[];
}
```

- [ ] **Step 11.2:** Commit:

```bash
git add src/data/catalog.ts
git commit -m "feat: read queries — doctors, patients, availability view, patient bookings"
```

### Task 12: API route handlers + edge-case tests (TDD)

**Files:**
- Create: `src/lib/api.ts`, `src/app/api/doctors/route.ts`, `src/app/api/doctors/[id]/slots/route.ts`, `src/app/api/patients/route.ts`, `src/app/api/bookings/route.ts`, `src/app/api/bookings/[id]/confirm/route.ts`, `src/app/api/bookings/[id]/cancel/route.ts`, `src/app/api/bookings/[id]/complete/route.ts`
- Test: `tests/integration/api.test.ts`

Note: `GET /api/patients` is a demo-support endpoint (feeds the UI's patient switcher); it stands in for "who am I" under real auth. Flag it as such in the README.

- [ ] **Step 12.1:** Write failing tests `tests/integration/api.test.ts` — route handlers are plain functions taking `Request`, so we invoke them directly (no server to spawn):

```ts
import { describe, expect, it } from 'vitest';
import { POST as createBookingRoute } from '@/app/api/bookings/route';
import { POST as confirmRoute } from '@/app/api/bookings/[id]/confirm/route';
import { createTestSlot, PATIENTS } from '../helpers';

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
```

- [ ] **Step 12.2:** Run to verify failure:

```bash
pnpm test:integration
```

Expected: FAIL — route modules don't exist.

- [ ] **Step 12.3:** Create `src/lib/api.ts` (error envelope + status mapping in one place):

```ts
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
```

- [ ] **Step 12.4:** Create the routes.

`src/app/api/doctors/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { listDoctors } from '@/data/catalog';

export async function GET() {
  return NextResponse.json({ doctors: await listDoctors() });
}
```

`src/app/api/patients/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { listPatients } from '@/data/catalog';

export async function GET() {
  return NextResponse.json({ patients: await listPatients() });
}
```

`src/app/api/doctors/[id]/slots/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listAvailableSlots } from '@/data/catalog';
import { errorResponse } from '@/lib/api';

const paramsSchema = z.object({ id: z.string().uuid() });

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = paramsSchema.safeParse(await ctx.params);
  if (!parsed.success) return errorResponse('VALIDATION_ERROR', 'Doctor id must be a UUID.');
  return NextResponse.json({ slots: await listAvailableSlots(parsed.data.id) });
}
```

`src/app/api/bookings/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createBooking } from '@/data/bookings';
import { listBookingsForPatient } from '@/data/catalog';
import { errorResponse, requirePatientId } from '@/lib/api';

const bodySchema = z.object({ slotId: z.string().uuid() });

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
```

`src/app/api/bookings/[id]/confirm/route.ts` (cancel/complete are identical apart from the event — three small files keep routes discoverable in the tree; the shared logic lives in one helper):

```ts
import { transitionRoute } from '@/lib/transition-route';

export const POST = transitionRoute('confirm');
```

`src/app/api/bookings/[id]/cancel/route.ts`:

```ts
import { transitionRoute } from '@/lib/transition-route';

export const POST = transitionRoute('cancel');
```

`src/app/api/bookings/[id]/complete/route.ts`:

```ts
import { transitionRoute } from '@/lib/transition-route';

export const POST = transitionRoute('complete');
```

`src/lib/transition-route.ts`:

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { transitionBooking } from '@/data/bookings';
import { errorResponse } from '@/lib/api';

const paramsSchema = z.object({ id: z.string().uuid() });

export function transitionRoute(event: 'confirm' | 'cancel' | 'complete') {
  return async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
    const parsed = paramsSchema.safeParse(await ctx.params);
    if (!parsed.success) return errorResponse('BOOKING_NOT_FOUND');

    const result = await transitionBooking({ bookingId: parsed.data.id, event });
    if (!result.ok) return errorResponse(result.code);
    return NextResponse.json({ booking: result.booking });
  };
}
```

- [ ] **Step 12.5:** Run all tests:

```bash
pnpm test
```

Expected: PASS — unit + integration, including the new API tests.

- [ ] **Step 12.6:** Smoke the API end-to-end once with a real server:

```bash
pnpm dev &
sleep 5
curl -s http://localhost:3000/api/doctors | head -c 300
curl -s -X POST http://localhost:3000/api/bookings -H 'content-type: application/json' -H 'x-patient-id: 00000000-0000-0000-0000-0000000000a1' -d '{"slotId":"<pick one from /api/doctors/00000000-0000-0000-0000-0000000000d1/slots>"}'
kill %1
```

Expected: doctors JSON; booking created with `"status":"pending"`.

- [ ] **Step 12.7:** Commit:

```bash
git add src/app/api src/lib tests/integration/api.test.ts
git commit -m "feat: API routes — thin handlers, Zod at the boundary, one error envelope

Routes parse and map; all decisions live in domain/data. Error codes
and HTTP statuses centralized in lib/api so the contract stays uniform."
```

### Task 13: Open & merge PR4

- [ ] **Step 13.1:**

```bash
git push -u origin feat/api-routes
gh pr create --title "API: transitions with optimistic concurrency + full route surface" --body "## What
- \`transitionBooking\`: pure domain decision applied via \`UPDATE … WHERE status = expected\` — concurrent confirm/cancel races proven safe by test (exactly one wins, no corruption)
- 7 routes + \`GET /api/patients\` (demo-support stand-in for auth identity)
- Zod validation at the boundary; single \`{ error: { code, message } }\` envelope with centralized status mapping

## Note
Handlers are deliberately logic-free — they parse, delegate, and map. Business rules are only in \`domain/\` (tested pure) and invariants only in Postgres."
gh pr merge --squash --delete-branch
git checkout main && git pull
```

---

## PR5 — Minimal UI (branch: `feat/booking-ui`)

### Task 14: One-page booking UI

**Files:**
- Create: `src/app/booking-page.tsx` (client component)
- Modify: `src/app/page.tsx`, `src/app/layout.tsx` (title only)

- [ ] **Step 14.1:** Create branch:

```bash
git checkout -b feat/booking-ui
```

- [ ] **Step 14.2:** Initialize shadcn/ui and add the three components used:

```bash
pnpm dlx shadcn@latest init -d
pnpm dlx shadcn@latest add button card badge
```

- [ ] **Step 14.3:** Replace `src/app/page.tsx`:

```tsx
import { BookingPage } from './booking-page';

export default function Home() {
  return <BookingPage />;
}
```

- [ ] **Step 14.4:** Create `src/app/booking-page.tsx`. Full component (client-side, consumes the public API only — the UI dogfoods the same contract a mobile app would):

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
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

  useEffect(() => {
    fetch('/api/patients').then((r) => r.json()).then(({ patients }) => {
      setPatients(patients);
      setPatientId(patients[0]?.id ?? '');
    });
    fetch('/api/doctors').then((r) => r.json()).then(({ doctors }) => {
      setDoctors(doctors);
      setDoctorId(doctors[0]?.id ?? '');
    });
  }, []);

  const refresh = useCallback(async () => {
    if (doctorId) {
      const { slots } = await (await fetch(`/api/doctors/${doctorId}/slots`)).json();
      setSlots(slots);
    }
    if (patientId) {
      const { bookings } = await (
        await fetch('/api/bookings', { headers: { 'x-patient-id': patientId } })
      ).json();
      setBookings(bookings);
    }
  }, [doctorId, patientId]);

  useEffect(() => { refresh(); }, [refresh]);

  async function book(slotId: string) {
    const res = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-patient-id': patientId },
      body: JSON.stringify({ slotId }),
    });
    const json = await res.json();
    setMessage(res.ok ? 'Slot held for 10 minutes — confirm below.' : `${json.error.code}: ${json.error.message}`);
    await refresh();
  }

  async function act(bookingId: string, action: 'confirm' | 'cancel') {
    const res = await fetch(`/api/bookings/${bookingId}/${action}`, { method: 'POST' });
    const json = await res.json();
    setMessage(res.ok ? `Booking ${json.booking.status}.` : `${json.error.code}: ${json.error.message}`);
    await refresh();
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
          <CardTitle className="flex items-center gap-3 text-base">
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
```

- [ ] **Step 14.5:** Update the `<title>` in `src/app/layout.tsx` metadata to `RapiDr Booking` and remove scaffold boilerplate from the page if any remains.

- [ ] **Step 14.6:** Manual verification (`pnpm dev`):
  1. Book a slot as Alice → appears as `pending` with Confirm/Cancel.
  2. Open a second tab as Ben, try the same slot → `SLOT_TAKEN` message.
  3. Confirm as Alice → badge flips to `confirmed`; the slot no longer appears in the grid.
  4. Cancel → slot reappears in the grid.

- [ ] **Step 14.7:** Run full test suite (guard against regressions), then commit:

```bash
pnpm test
git add -A
git commit -m "feat: minimal one-page booking UI

Consumes only the public API (same contract a mobile client would use).
Deliberately unstyled beyond shadcn defaults — time went to correctness."
```

### Task 15: Open & merge PR5

- [ ] **Step 15.1:**

```bash
git push -u origin feat/booking-ui
gh pr create --title "Minimal booking UI (demo surface for the API)" --body "## What
One page: patient switcher (auth stand-in) → doctor picker → slot grid → my-bookings with state badges and confirm/cancel.

## Why minimal
The rubric weights correctness and structure, not CSS. The UI exists to make the deployed link demo-able — including racing two tabs to see the 409 path — and to prove the API contract works end-to-end."
gh pr merge --squash --delete-branch
git checkout main && git pull
```

---

## PR6 — Deploy + README (branch: `feat/deploy-readme`)

### Task 16: Supabase cloud + Vercel deploy

**Files:**
- Modify: `.env.local` (cloud values)

- [ ] **Step 16.1:** Create branch:

```bash
git checkout -b feat/deploy-readme
```

- [ ] **Step 16.2:** Create a **throwaway** Supabase cloud project (dashboard: new project, name `rapidr-booking-assessment`). Push schema and seed:

```bash
supabase link --project-ref <PROJECT_REF>
supabase db push
psql "<CLOUD_CONNECTION_STRING>" -f supabase/seed.sql
```

Expected: migration applied; seed inserted (verify in dashboard table editor).

- [ ] **Step 16.3:** Update `.env.local` with the cloud `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (from dashboard → Settings → API). `.env.test` keeps pointing at local. Commit — this is the brief's explicit request; the project is throwaway and gets paused after the interview cycle.

- [ ] **Step 16.4:** Deploy to Vercel:

```bash
pnpm dlx vercel --prod
```

Set the two env vars when prompted (or via `vercel env add`). Expected: production URL live.

- [ ] **Step 16.5:** Smoke the live deployment:

```bash
curl -s https://<DEPLOYMENT_URL>/api/doctors | head -c 300
```

Expected: seeded doctors JSON. Then click through the UI once (book → confirm → cancel).

- [ ] **Step 16.6:** Commit:

```bash
git add .env.local
git commit -m "chore: point committed env at throwaway cloud Supabase for the live deploy"
```

### Task 17: README

**Files:**
- Create: `README.md` (replace scaffold README)

- [ ] **Step 17.1:** Write `README.md` with exactly these sections (content sourced from spec — spec §4–§9 text can be adapted directly; keep it in first person, it will be read as your voice):

1. **What this is** — 2 sentences + live link + one screenshot. One paragraph of background: built booking state machines for healthcare systems before (mymediset medical-logistics internship, medical appointment-booking capstone); this shaped the design choices below.
2. **Quick start** — exactly three commands: `pnpm install`, `supabase start && supabase db reset`, `pnpm dev`. Plus `pnpm test` / `pnpm test:unit` / `pnpm test:integration` (note: integration needs `supabase start`).
3. **Tech stack & why** — table from spec §2 including the rejected alternatives.
4. **Architecture** — the `src/` tree from spec §3 with the one-line responsibility per layer.
5. **The concurrency design** — spec §4: the partial unique index, why check-then-insert is a race, the rejected alternatives (`FOR UPDATE`, advisory locks, serializable) and when each becomes necessary (booking+payment atomicity).
6. **State machine** — spec §5 diagram + table, the 10-minute hold rationale, lazy expiry and reap-before-insert ordering.
7. **API overview** — spec §6 table + the error envelope + curl example for booking incl. `Idempotency-Key`.
8. **Race-condition tests** — what each proves (20-way booking race, expiry rebooking race, concurrent confirm-vs-cancel, concurrent idempotent retries); how to run.
9. **Assumptions & deliberate omissions** — spec §9 list, one line of "production approach" each. Include: `x-patient-id` stands in for auth; committed env vars are intentional per the brief (throwaway project).
10. **What I'd do at 100× load** — read replicas for availability queries; slot-availability caching with short TTL (the index still guarantees correctness when the cache is stale — cache can lie, the arbiter can't); connection pooling (pgBouncer/Supavisor); moving expiry to a sweep job once notifications/analytics need it; partitioning bookings by time.
11. **AI usage** — used Claude Code as a pair programmer. All architectural decisions (DB-level uniqueness over locking, pending-with-expiry, lazy reaping, deliberate omissions) are mine; the design spec (`docs/specs/`) was written and committed before any code, and the race-condition test suite is how generated code was verified rather than trusted.

- [ ] **Step 17.2:** Add the screenshot: run the app, capture the booking page, save to `docs/screenshot.png`, reference from README.

- [ ] **Step 17.3:** Fresh-clone verification (the README's own instructions, followed literally):

```bash
cd /private/tmp/claude-501/-Users-hid-Developer-rapidr-booking-assessment/c3920d3b-9254-41c6-9e64-a1b2a091975d/scratchpad
git clone /Users/hid/Developer/rapidr-booking-assessment readme-check && cd readme-check
pnpm install && supabase start && supabase db reset && pnpm test
```

Expected: everything passes following only documented steps. Fix the README if anything was assumed but unwritten.

- [ ] **Step 17.4:** Commit:

```bash
git add README.md docs/screenshot.png
git commit -m "docs: README — setup, stack rationale, concurrency design, omissions, AI usage"
```

### Task 18: Final PR, review sweep, submission

- [ ] **Step 18.1:** Anti-slop sweep before the final merge — check for the tells reviewers look for:

```bash
pnpm lint
pnpm dlx knip   # unused files/exports/dependencies — remove anything it flags
grep -rn "TODO\|FIXME\|console.log" src/ && echo "^ remove these" || echo "clean"
```

Also manually skim every file once: no dead code, no comment noise, no unused imports, no scaffold leftovers (`favicon` boilerplate, template CSS).

- [ ] **Step 18.2:** Open & merge PR6:

```bash
git push -u origin feat/deploy-readme
gh pr create --title "Deploy (Vercel + Supabase cloud) and README" --body "## What
Live deployment + the full write-up: stack rationale, concurrency design with rejected alternatives, state machine, assumptions/omissions, 100×-load notes, AI-usage statement.

## Verification
README instructions verified against a fresh clone: install → supabase start → db reset → full test suite green."
gh pr merge --squash --delete-branch
git checkout main && git pull
```

- [ ] **Step 18.3:** Draft the submission email (send from your own mail client — review before sending):

> **To:** hello@rapidr.sg
> **Subject:** Take-home submission — Consultation Booking System — Muhammad Hidayah
>
> Hi RapiDr team,
>
> My submission for the Software Engineer take-home (Scope 1, Consultation Booking System):
>
> - **Repo:** https://github.com/Mhidayah19/rapidr-booking-assessment
> - **Live demo:** https://\<DEPLOYMENT_URL\>
>
> The README covers setup (3 commands), the concurrency design (double-booking is prevented by a partial unique index in Postgres — the race-condition test suite proves exactly-one-winner under 20 concurrent requests), the booking state machine, and what I deliberately left out and why. The design spec I wrote before starting is in `docs/specs/`.
>
> Happy to walk through any part of it live.
>
> Best regards,
> Muhammad Hidayah

- [ ] **Step 18.4:** Final checks against spec §11 success criteria: race test green, transitions exhaustively tested, 3-command setup verified from fresh clone, live link works, README omissions explicit. Submit **Thursday night** — Friday is buffer, not target.

---

## Self-review notes (already applied)

- **Spec coverage:** §4 schema → Task 3; §5 machine + reap ordering → Tasks 5, 8; §6 API incl. idempotency + envelope → Task 12 (plus `GET /api/patients` as documented demo support); §7 tests → Tasks 5, 8, 10, 12; §8 UI → Task 14; §9 omissions + §10 README/PR flow → Tasks 17, PR bodies throughout; §11 criteria → Task 18.4.
- **Type consistency:** `transition(booking, event, now)` signature identical in Tasks 5 and 10; `CreateBookingResult`/`BookingRow` shapes match between Tasks 8 and 11/12; route param style (`params: Promise<{id}>`) consistent across Task 12 files.
- **Known judgment calls:** UI as a single client component (one file, ~180 lines) rather than split components — deliberate; splitting would be ceremony at this size. `transitionRoute` helper avoids three copy-pasted route files while keeping the URL structure explicit.
