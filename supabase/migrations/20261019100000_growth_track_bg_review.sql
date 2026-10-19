-- Background check review list for Growth Track.
-- The PCO API can't order background checks (that happens on the person's PCO
-- profile via the Protect My Ministry add-on), so the app keeps a review list:
--   bg_status null      = not on the list
--   bg_status 'needed'  = finished all 3 steps, no valid check; waiting on an admin
--   bg_status 'ordered' = admin ordered it in PCO (app also sets bg_invite = true)
--   bg_status 'removed' = admin took them off the list
alter table public.growth_track_people
  add column if not exists pco_person_id  text,
  add column if not exists bg_status      text,
  add column if not exists bg_reason      text,
  add column if not exists bg_last_status text,
  add column if not exists bg_status_at   timestamptz;

alter table public.growth_track_people drop constraint if exists growth_track_people_bg_status_chk;
alter table public.growth_track_people add constraint growth_track_people_bg_status_chk
  check (bg_status is null or bg_status in ('needed','ordered','removed'));

create index if not exists growth_track_people_bg_status_idx
  on public.growth_track_people (bg_status) where bg_status is not null;
create index if not exists growth_track_people_pco_person_idx
  on public.growth_track_people (pco_person_id);

comment on column public.growth_track_people.pco_person_id  is 'Planning Center People person id (numeric, without the AC prefix).';
comment on column public.growth_track_people.bg_status      is 'Background check review: needed | ordered | removed; null = not on the list.';
comment on column public.growth_track_people.bg_reason      is 'Why they are on the list, e.g. Never checked / Invite expired.';
comment on column public.growth_track_people.bg_last_status is 'Human-readable summary of their last PCO background check.';
comment on column public.growth_track_people.bg_status_at   is 'When bg_status last changed.';

-- The existing "growth_track update" policy (can_access_campus) already lets
-- admins update these columns. Counters can edit their campus rows, so guard
-- the review columns: only admins (or service role / SQL, where auth.uid() is
-- null) may change them.
create or replace function public.growth_track_bg_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.bg_status is not null or new.bg_reason is not null or new.bg_last_status is not null or new.bg_status_at is not null then
      raise exception 'Only admins can set background check review fields';
    end if;
  elsif new.bg_status is distinct from old.bg_status
     or new.bg_reason is distinct from old.bg_reason
     or new.bg_last_status is distinct from old.bg_last_status
     or new.bg_status_at is distinct from old.bg_status_at
     or new.pco_person_id is distinct from old.pco_person_id then
    raise exception 'Only admins can change background check review fields';
  end if;
  return new;
end $$;

drop trigger if exists growth_track_people_bg_guard on public.growth_track_people;
create trigger growth_track_people_bg_guard
  before insert or update on public.growth_track_people
  for each row execute function public.growth_track_bg_guard();
