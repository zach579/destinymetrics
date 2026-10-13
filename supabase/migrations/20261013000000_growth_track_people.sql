-- Growth Track people (Step 1-3 cohort tracking)
create table if not exists public.growth_track_people (
  id uuid primary key default gen_random_uuid(),
  campus_id uuid not null references public.campuses(id) on delete cascade,
  start_date date,
  name text not null,
  phone text, email text, birth_date date, address text, children text,
  table_host text, notes text, question text,
  step1_date date, step2_date date, step3_date date,
  gifts text, team_preference text,
  bg_invite boolean not null default false,
  added_slack boolean not null default false,
  follow_up_wf boolean not null default false,
  team_joined boolean not null default false,
  source text default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists growth_track_people_campus_start on public.growth_track_people (campus_id, start_date);

create or replace function public.can_access_campus(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (
    select 1 from public.user_campuses uc where uc.campus_id = cid and uc.user_id = auth.uid()
  );
$$;

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists growth_track_people_touch on public.growth_track_people;
create trigger growth_track_people_touch before update on public.growth_track_people
  for each row execute function public.touch_updated_at();

alter table public.growth_track_people enable row level security;
drop policy if exists "growth_track read" on public.growth_track_people;
drop policy if exists "growth_track insert" on public.growth_track_people;
drop policy if exists "growth_track update" on public.growth_track_people;
drop policy if exists "growth_track delete" on public.growth_track_people;
create policy "growth_track read" on public.growth_track_people for select to authenticated using (public.can_access_campus(campus_id));
create policy "growth_track insert" on public.growth_track_people for insert to authenticated with check (public.can_access_campus(campus_id));
create policy "growth_track update" on public.growth_track_people for update to authenticated using (public.can_access_campus(campus_id)) with check (public.can_access_campus(campus_id));
create policy "growth_track delete" on public.growth_track_people for delete to authenticated using (public.can_access_campus(campus_id));
grant select, insert, update, delete on public.growth_track_people to authenticated;
