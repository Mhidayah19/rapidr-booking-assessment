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
select d.id, t.ts, t.ts + interval '30 minutes'
from doctors d
cross join generate_series(
  date_trunc('day', now() at time zone 'Asia/Singapore') + interval '1 day',
  date_trunc('day', now() at time zone 'Asia/Singapore') + interval '14 days',
  interval '30 minutes'
) as g(ts_sgt)
cross join lateral (select g.ts_sgt at time zone 'Asia/Singapore' as ts) t
where extract(hour from g.ts_sgt) between 9 and 16;
