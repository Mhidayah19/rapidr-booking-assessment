# Consultation Booking System — Design Spec

**Assessment:** GoDoc (Singapore) / RapiDr — Software Engineer take-home
**Scope chosen:** 1. Consultation Booking System
**Author:** Muhammad Hidayah
**Date:** 2026-07-06 · **Submission deadline:** 2026-07-10, 23:59 SGT (target: Thu 2026-07-09 night)

---

## 1. Objective

Patients view available slots for a doctor and book one. The assessment grades:

1. **Correctness under concurrency** — two simultaneous requests for the same slot must not double-book.
2. **An explicit booking state machine** with valid transitions.
3. **Structure that stays correct as load increases** and can grow (more features, more developers) without a rewrite.
4. **Clear communication of trade-offs, assumptions, and deliberate omissions.**

Guiding principle from the brief: *a smaller, well-reasoned solution beats a larger, rushed one.* Every scope decision below optimizes for that.

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| App | Next.js (App Router, TypeScript) | What I genuinely use daily (MyRideSG); one deployable serving both API routes and the minimal UI; free instant deploy on Vercel |
| Database | PostgreSQL (Supabase-hosted) | The double-booking invariant is enforced *by Postgres itself* (partial unique index) — correct across any number of app instances |
| DB access | `@supabase/supabase-js` (server-only, service role) | My daily driver; no ORM to justify. Multi-statement atomicity, where needed, goes into SQL (migrations own the invariants) |
| Validation | Zod at the API boundary | Validate at system boundaries; trust internal invariants |
| Tests | Vitest | Unit tests for the pure domain layer; integration tests (incl. race tests) against local Supabase Postgres |
| UI | React + Tailwind + shadcn/ui, one page | Deliberately minimal — effort goes to correctness, not CSS |

**Explicitly rejected:** NestJS (heavier than needed for this scope), an ORM (adds a layer between reviewer and the SQL that carries the correctness argument), Turborepo monorepo (over-engineering for one app).

## 3. Architecture

```
src/
  domain/        # PURE. No I/O. Booking state machine, availability rules, types.
  data/          # Supabase adapters (server-only). Implements what domain needs.
  app/api/       # Thin route handlers: parse (Zod) → call data/domain → map errors to HTTP.
  app/           # One-page UI (doctor picker → slot grid → my bookings).
supabase/
  migrations/    # Schema owns the invariants (constraints, indexes).
  seed.sql       # Doctors, patients, ~14 days of slots.
```

Rationale: three layers, no ceremony. The state machine is pure and unit-testable with zero DB. Data adapters can be swapped without touching domain. Route handlers contain no business logic. This is the same domain/data separation I use in production work — it grows by adding modules, not by rewriting.

## 4. Data model

```sql
doctors   (id uuid PK, name text, specialty text)
patients  (id uuid PK, name text, email text)
slots     (id uuid PK, doctor_id uuid FK, starts_at timestamptz, ends_at timestamptz,
           UNIQUE (doctor_id, starts_at))
bookings  (id uuid PK, slot_id uuid FK, patient_id uuid FK,
           status booking_status NOT NULL,           -- enum, see §5
           expires_at timestamptz,                   -- set while status='pending'
           idempotency_key text,
           created_at timestamptz, updated_at timestamptz,
           UNIQUE (patient_id, idempotency_key))
```

**The double-booking guarantee — the core of this submission:**

```sql
CREATE UNIQUE INDEX one_active_booking_per_slot
  ON bookings (slot_id)
  WHERE status IN ('pending', 'confirmed');
```

At most one *active* booking can ever exist per slot, enforced by the storage layer. Application code never does check-then-insert (a race); it inserts and maps a unique violation (`23505`) to HTTP 409. This holds under any number of concurrent requests and any number of serverless instances.

*Alternatives considered:* `SELECT … FOR UPDATE` in a transaction (works, but requires a transaction-capable connection path and holds locks under load); advisory locks (same, plus more machinery); `SERIALIZABLE` isolation (retry loops for a problem the index solves declaratively). These become relevant when booking must be atomic with side effects (e.g. payment capture) — discussed in README, not needed here.

All timestamps `timestamptz`; display timezone `Asia/Singapore` (README assumption).

## 5. Booking state machine

```
                     confirm                    complete (after slot ends)
       ┌─────────┐ ───────────► ┌───────────┐ ───────────► ┌───────────┐
book ─►│ PENDING │              │ CONFIRMED │              │ COMPLETED │
       └─────────┘ ───────────► └───────────┘              └───────────┘
          │   expire (10 min)         │
          │ cancel                    │ cancel (before slot starts)
          ▼                           ▼
      ┌───────────┐             ┌───────────┐
      │ CANCELLED │             │ CANCELLED │
      └───────────┘             └───────────┘
      (EXPIRED is terminal, reached only from PENDING)
```

| From | Event | To | Guard |
|---|---|---|---|
| — | `book` | `pending` | slot exists, `starts_at > now`, no active booking (index) |
| `pending` | `confirm` | `confirmed` | `now < expires_at` |
| `pending` | `cancel` | `cancelled` | — |
| `pending` | `expire` | `expired` | `now ≥ expires_at` (system-applied, lazy) |
| `confirmed` | `cancel` | `cancelled` | `now < slot.starts_at` |
| `confirmed` | `complete` | `completed` | `now ≥ slot.ends_at` |

Terminal states: `cancelled`, `completed`, `expired`. Everything else → 409 with a machine-readable error code.

**Why `pending` + expiry:** a hold that never expires is a design bug — an abandoned booking blocks the slot forever. `pending` holds the slot for **10 minutes** (mirrors real clinic "confirm to secure your slot" flows); expiry is **lazy** — no cron:

- Availability reads treat `pending AND expires_at < now()` as free.
- The **booking flow reaps before inserting** (this ordering matters — an expired-but-unreaped row still occupies the partial unique index):
  1. `UPDATE bookings SET status='expired' WHERE slot_id=$1 AND status='pending' AND expires_at < now()`
  2. `INSERT … status='pending', expires_at = now() + interval '10 minutes'`
  3. `23505` → 409 SLOT_TAKEN

  No transaction needed across the two statements: each is atomic, and the unique index remains the single arbiter. Worst-case race outcome is a spurious 409 (client retries) — never a double-booking.

**Implementation split:**
- `domain/`: pure `transition(booking, event, now)` — returns next state or a typed rejection. Exhaustively unit-tested.
- `data/`: applies transitions with **optimistic concurrency** — `UPDATE … SET status=$next WHERE id=$id AND status=$expected`; zero rows updated → 409. Concurrent double-confirm/double-cancel cannot corrupt state.

**Idempotent booking:** optional `Idempotency-Key` header. Same `(patient_id, key)` → return the existing booking (200) instead of creating another. A timed-out client retry can't double-book or double-hold.

## 6. API

| Method & path | Purpose | Notable responses |
|---|---|---|
| `GET /api/doctors` | List doctors | |
| `GET /api/doctors/:id/slots` | Available future slots (excludes active bookings; treats expired pendings as free) | |
| `POST /api/bookings` | Book a slot `{slotId}` (+ optional `Idempotency-Key`) | `201`; `409 SLOT_TAKEN`; `422` past/unknown slot |
| `POST /api/bookings/:id/confirm` | pending → confirmed | `409 INVALID_TRANSITION` / `HOLD_EXPIRED` |
| `POST /api/bookings/:id/cancel` | pending/confirmed → cancelled | `409 INVALID_TRANSITION` |
| `POST /api/bookings/:id/complete` | confirmed → completed | guard: after `ends_at` |
| `GET /api/bookings` | Current patient's bookings | |

Errors: consistent envelope `{ error: { code, message } }`. Patient identity: **`x-patient-id` header** against seeded patients — a documented stand-in for real auth (§9).

## 7. Testing plan (bonus rubric: race-condition tests)

1. **Domain unit tests (Vitest, pure):** every transition in the table, every invalid transition, expiry boundary conditions.
2. **Race integration tests (Vitest against local Supabase Postgres) — the centerpiece:**
   - N=20 concurrent `POST /api/bookings` for one slot → **exactly 1 succeeds (201), 19 get 409**, exactly one active row exists.
   - Expired pending: book → let hold lapse → concurrent rebooking race → exactly one new winner; old row is `expired`.
   - Concurrent confirm vs cancel on the same booking → exactly one wins (optimistic concurrency).
   - Idempotent retry: same key twice → one booking, same body returned.
3. **API edge cases:** unknown/past slot, malformed body (Zod 400), confirm after expiry.

Run: `supabase start && pnpm test`. CI (GitHub Actions) runs unit tests; integration tests documented as local (spinning Supabase in CI is possible; noted as a follow-up).

## 8. Frontend (deliberately minimal)

One page: doctor picker → slot grid (available/held/booked) → book → "my bookings" list with status badges and confirm/cancel buttons. Patient switcher (seeded patients) to demo two-patient races from two tabs. No styling investment beyond Tailwind/shadcn defaults — stated in README as an explicit time-allocation choice.

## 9. Deliberate omissions (README will state each + why)

- **Auth/RLS** — solved problem (Supabase Auth in my production work); omitting keeps review focus on booking correctness. Service-role key server-side only.
- **Doctor schedule recurrence** — slots are seeded concrete rows; production would derive them from weekly availability + exceptions.
- **Rescheduling** — composition of `cancel` + `book`; not a new state.
- **Payments, notifications, admin views, rate limiting, pagination** — out of scope; one line each on the production approach.
- **Cron-based expiry sweep** — lazy expiry is sufficient and simpler; a sweep becomes worthwhile for analytics/notifications.

## 10. Delivery plan

**Repo:** public GitHub repo, `.env` committed (throwaway Supabase project — per the brief's explicit instruction). PR-based flow, squash-merged, each PR description records the decisions it embodies:

1. **PR1 — Scaffold & schema:** Next.js scaffold, Supabase local setup, migrations (incl. the partial unique index), seed. *(This spec commits directly to `main` first.)*
2. **PR2 — Domain state machine** + exhaustive unit tests.
3. **PR3 — Booking endpoint** (reap → insert → 409 mapping, idempotency) + race integration tests.
4. **PR4 — Remaining endpoints** (confirm/cancel/complete/listings) + optimistic-concurrency transitions + edge-case tests.
5. **PR5 — UI.**
6. **PR6 — Deploy (Vercel + Supabase cloud) & README.**

**Timeline:** Mon 07-06 spec+PR1 · Tue 07-07 PR2+PR3 · Wed 07-08 PR4+PR5 · Thu 07-09 PR6, submission email. Friday = buffer.

**README structure:** healthcare-booking background (mymediset/capstone) → stack justification → architecture → concurrency design & alternatives → state machine → API overview → setup (≤3 commands) & tests → assumptions & omissions → "at 100× load" note → **AI usage statement** (Claude Code as pair programmer; all architectural decisions mine; race-test suite is how generated code was verified, not trusted).

## 11. Success criteria

- Race test proves exactly-one-winner under 20 concurrent requests.
- Every state transition unit-tested; invalid transitions rejected with typed errors.
- Fresh clone → running locally in ≤3 commands.
- Live deployed link.
- README makes every omission and trade-off explicit.
- I can defend any line of this repo live without notes.
