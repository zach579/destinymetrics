-- Let counters read/write Next Steps people for their own campuses (admins: all).
drop policy if exists "next_steps_people admin read" on public.next_steps_people;
drop policy if exists "next_steps_people admin write" on public.next_steps_people;
drop policy if exists "next_steps_people campus read" on public.next_steps_people;
drop policy if exists "next_steps_people campus write" on public.next_steps_people;
create policy "next_steps_people campus read" on public.next_steps_people for select to authenticated using (public.can_access_campus(campus_id));
create policy "next_steps_people campus write" on public.next_steps_people for all to authenticated using (public.can_access_campus(campus_id)) with check (public.can_access_campus(campus_id));
