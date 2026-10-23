-- Who to contact: step-based follow-up list for Growth Track (not PCO workflows).
-- contact_status null = never evaluated / not on list
--               needed = show on "Who to contact" this week or overdue
--               contacted = marked done; stays off the list
--               dismissed = intentionally removed; stays off the list
-- Campus counters may edit these (same RLS as other GT fields). Not guarded by growth_track_bg_guard.

alter table public.growth_track_people
  add column if not exists contact_status   text,
  add column if not exists contact_reason   text,
  add column if not exists contact_due_date date,
  add column if not exists contacted_at     timestamptz,
  add column if not exists contact_note     text;

alter table public.growth_track_people drop constraint if exists growth_track_people_contact_status_chk;
alter table public.growth_track_people add constraint growth_track_people_contact_status_chk
  check (contact_status is null or contact_status in ('needed','contacted','dismissed'));

create index if not exists growth_track_people_contact_needed_idx
  on public.growth_track_people (campus_id, contact_due_date)
  where contact_status = 'needed';

comment on column public.growth_track_people.contact_status is
  'Follow-up list: needed | contacted | dismissed; null = not on the list.';
comment on column public.growth_track_people.contact_reason is
  'Why they need contact, e.g. Missing Step 2 / Missing Step 3 / Needs team pick.';
comment on column public.growth_track_people.contact_due_date is
  'When follow-up is due (usually prior step date + 7 days).';
comment on column public.growth_track_people.contacted_at is
  'When an admin/counter marked them contacted.';
comment on column public.growth_track_people.contact_note is
  'Optional note from the person who contacted or dismissed them.';
