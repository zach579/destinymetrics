-- Track the heads-up email sent when an admin presses Order on a
-- "Background checks needed" row. Written by the Apps Script web app
-- (bgOrderEmail_) using the calling admin's own Supabase token.
alter table public.growth_track_people
  add column if not exists bg_email_sent_at  timestamptz,
  add column if not exists bg_email_to       text,
  add column if not exists bg_email_template text;

comment on column public.growth_track_people.bg_email_sent_at  is 'When the background-check heads-up email was last sent.';
comment on column public.growth_track_people.bg_email_to       is 'Address the background-check heads-up email went to.';
comment on column public.growth_track_people.bg_email_template is 'Which template was sent: FIRST or REORDER.';

-- Same admin-only guard as the other bg_* review columns, now covering the email columns too.
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
    if new.bg_status is not null or new.bg_reason is not null or new.bg_last_status is not null or new.bg_status_at is not null
       or new.bg_email_sent_at is not null or new.bg_email_to is not null or new.bg_email_template is not null then
      raise exception 'Only admins can set background check review fields';
    end if;
  elsif new.bg_status is distinct from old.bg_status
     or new.bg_reason is distinct from old.bg_reason
     or new.bg_last_status is distinct from old.bg_last_status
     or new.bg_status_at is distinct from old.bg_status_at
     or new.pco_person_id is distinct from old.pco_person_id
     or new.bg_email_sent_at is distinct from old.bg_email_sent_at
     or new.bg_email_to is distinct from old.bg_email_to
     or new.bg_email_template is distinct from old.bg_email_template then
    raise exception 'Only admins can change background check review fields';
  end if;
  return new;
end $$;
