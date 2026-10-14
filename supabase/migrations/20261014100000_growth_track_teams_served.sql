-- Add teams_served: comma-separated unique list of PCO teams a Growth Track
-- person has held a position on / been scheduled for. Filled by bot sync;
-- UI can show it later. Nullable; leave null when unknown / never served.
alter table public.growth_track_people
  add column if not exists teams_served text;

comment on column public.growth_track_people.teams_served is
  'Comma-separated unique PCO team names the person has served on (from Services scheduling / team positions).';
