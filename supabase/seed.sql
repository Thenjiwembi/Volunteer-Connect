-- Volunteer Connect sample development data.
-- This file intentionally uses .test emails and only inserts rows when the matching
-- Supabase Auth users already exist. It never creates real accounts or credentials.
-- Create these Auth users through Supabase Auth first, then run this file in a
-- development project only:
--   demo.volunteer@example.test
--   demo.organisation@example.test
--
-- The migration trigger creates pending volunteer profiles. This development-only
-- seed assigns the demo roles and activates both profiles before adding an
-- approved organisation and a future event.

do $$
declare
  organisation_owner uuid := (select id from auth.users where email = 'demo.organisation@example.test' limit 1);
  volunteer_owner uuid := (select id from auth.users where email = 'demo.volunteer@example.test' limit 1);
  organisation_id uuid;
begin
  if organisation_owner is null then return; end if;
  update public.profiles
  set role = 'organisation', account_status = 'active', approved_at = now(), approved_by = null
  where id = organisation_owner;
  update public.profiles
  set role = 'volunteer', account_status = 'active', approved_at = now(), approved_by = null
  where id = volunteer_owner;
  insert into public.organisations (owner_user_id, name, description, contact_email, location, approval_status)
  values (organisation_owner, 'Neighbourhood Pantry', 'A volunteer-run pantry helping local families access fresh food and practical support.', 'demo.organisation@example.test', 'Cape Town', 'approved')
  on conflict (owner_user_id) do update set approval_status = 'approved'
  returning id into organisation_id;
  if organisation_id is null then select id into organisation_id from public.organisations where owner_user_id = organisation_owner; end if;
  insert into public.events (organisation_id, title, description, category, location, event_date, start_time, end_time, capacity, status)
  values (organisation_id, 'Saturday pantry packing', 'Spend a morning sorting donated groceries and preparing parcels for neighbours who need a little extra support.', 'Food security', 'Observatory, Cape Town', current_date + 14, '09:00', '12:00', 18, 'published')
  on conflict do nothing;
end $$;
