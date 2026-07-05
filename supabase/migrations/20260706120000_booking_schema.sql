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
