-- Track auto-submit of Church Center form 551600 (DC - Growth Track Step 3).
-- Apps Script syncGrowthTrackStep3Forms POSTs a submission when someone first
-- has all 3 step dates + a mappable team_preference, then stores the id here.
-- Never auto-resubmit once form_551600_submission_id is set.
alter table public.growth_track_people
  add column if not exists form_551600_submission_id text,
  add column if not exists form_551600_submitted_at  timestamptz;

comment on column public.growth_track_people.form_551600_submission_id is
  'PCO FormSubmission id for form 551600 (DC Growth Track Step 3). Set once; never overwrite.';
comment on column public.growth_track_people.form_551600_submitted_at is
  'When form 551600 was auto-submitted for this person.';

create index if not exists growth_track_people_form_551600_idx
  on public.growth_track_people (form_551600_submission_id)
  where form_551600_submission_id is not null;

-- Extend the existing admin-only guard (bg_*) to cover form_551600_*.
-- Admins / service role (auth.uid() is null) may change anything.
-- Campus counters (automation user is a counter) may ONLY stamp
-- form_551600_submission_id / submitted_at once (null → value), so the
-- scheduled Apps Script can record a successful POST without being admin.
create or replace function public.growth_track_bg_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  form_stamp_only boolean;
begin
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.bg_status is not null or new.bg_reason is not null or new.bg_last_status is not null or new.bg_status_at is not null
       or new.bg_email_sent_at is not null or new.bg_email_to is not null or new.bg_email_template is not null
       or new.form_551600_submission_id is not null or new.form_551600_submitted_at is not null then
      raise exception 'Only admins can set background check / form-551600 fields on insert';
    end if;
    return new;
  end if;

  -- One-way stamp of form 551600 fields by a campus editor (e.g. automation@).
  form_stamp_only :=
       old.form_551600_submission_id is null
   and new.form_551600_submission_id is not null
   and new.form_551600_submitted_at is not null
   and new.bg_status is not distinct from old.bg_status
   and new.bg_reason is not distinct from old.bg_reason
   and new.bg_last_status is not distinct from old.bg_last_status
   and new.bg_status_at is not distinct from old.bg_status_at
   and new.pco_person_id is not distinct from old.pco_person_id
   and new.bg_email_sent_at is not distinct from old.bg_email_sent_at
   and new.bg_email_to is not distinct from old.bg_email_to
   and new.bg_email_template is not distinct from old.bg_email_template;

  if form_stamp_only then
    return new;
  end if;

  if new.bg_status is distinct from old.bg_status
     or new.bg_reason is distinct from old.bg_reason
     or new.bg_last_status is distinct from old.bg_last_status
     or new.bg_status_at is distinct from old.bg_status_at
     or new.pco_person_id is distinct from old.pco_person_id
     or new.bg_email_sent_at is distinct from old.bg_email_sent_at
     or new.bg_email_to is distinct from old.bg_email_to
     or new.bg_email_template is distinct from old.bg_email_template
     or new.form_551600_submission_id is distinct from old.form_551600_submission_id
     or new.form_551600_submitted_at is distinct from old.form_551600_submitted_at then
    raise exception 'Only admins can change background check / form-551600 fields';
  end if;
  return new;
end $$;
