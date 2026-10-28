alter table public.organisations
  add column if not exists verification_status text not null default 'pending',
  add column if not exists verification_feedback text,
  add column if not exists verification_submitted_at timestamptz,
  add column if not exists verification_reviewed_at timestamptz,
  add column if not exists verification_reviewed_by uuid references public.profiles(id) on delete set null,
  add column if not exists province text,
  add column if not exists city text,
  add column if not exists address text,
  add column if not exists service_area text;

update public.organisations
set verification_status = case approval_status
  when 'approved' then 'approved'
  when 'rejected' then 'rejected'
  else 'pending'
end,
verification_submitted_at = coalesce(verification_submitted_at, created_at),
verification_reviewed_at = coalesce(verification_reviewed_at, reviewed_at),
verification_reviewed_by = coalesce(verification_reviewed_by, reviewed_by);

alter table public.organisations
  drop constraint if exists organisations_verification_status_check;
alter table public.organisations
  add constraint organisations_verification_status_check
  check (verification_status in ('pending', 'approved', 'rejected', 'more_information_required'));

alter table public.profiles
  add column if not exists skills text[] not null default '{}',
  add column if not exists interests text[] not null default '{}',
  add column if not exists preferred_categories text[] not null default '{}',
  add column if not exists province text,
  add column if not exists city text,
  add column if not exists service_area text,
  add column if not exists available_days text[] not null default '{}',
  add column if not exists available_time_start time,
  add column if not exists available_time_end time,
  add column if not exists availability_notes text,
  add column if not exists experience text,
  add column if not exists participation_type text,
  add column if not exists preferred_distance_km numeric(6,2),
  add column if not exists share_with_organisations boolean not null default false;

alter table public.profiles
  drop constraint if exists profiles_participation_type_check,
  drop constraint if exists profiles_preferred_distance_check,
  drop constraint if exists profiles_available_days_check;
alter table public.profiles
  add constraint profiles_participation_type_check
    check (participation_type is null or participation_type in ('in_person', 'remote', 'hybrid')),
  add constraint profiles_preferred_distance_check
    check (preferred_distance_km is null or preferred_distance_km between 0 and 500),
  add constraint profiles_available_days_check
    check (available_days <@ array['monday','tuesday','wednesday','thursday','friday','saturday','sunday']::text[]),
  add constraint profiles_available_time_check
    check ((available_time_start is null and available_time_end is null) or (available_time_start is not null and available_time_end is not null and available_time_start < available_time_end));

alter table public.events
  add column if not exists required_skills text[] not null default '{}',
  add column if not exists participation_type text not null default 'in_person',
  add column if not exists eligibility text,
  add column if not exists application_deadline date;

alter table public.events
  drop constraint if exists events_participation_type_check,
  drop constraint if exists events_application_deadline_check;
alter table public.events
  add constraint events_participation_type_check
    check (participation_type in ('in_person', 'remote', 'hybrid')),
  add constraint events_application_deadline_check
    check (application_deadline is null or application_deadline <= event_date);

alter table public.registrations
  alter column attendance_status drop default;
alter table public.registrations
  alter column attendance_status type text using attendance_status::text,
  alter column attendance_status set default 'not_recorded',
  add column if not exists completed_hours numeric(5,2) not null default 0,
  add column if not exists hours_confirmed boolean not null default false,
  add column if not exists attendance_updated_by uuid references public.profiles(id) on delete set null,
  add column if not exists attendance_updated_at timestamptz;

alter table public.registrations
  drop constraint if exists registrations_attendance_status_check,
  drop constraint if exists registrations_completed_hours_check,
  drop constraint if exists registrations_attendance_hours_check;
alter table public.registrations
  add constraint registrations_attendance_status_check
    check (attendance_status in ('not_recorded', 'present', 'absent', 'excused')),
  add constraint registrations_completed_hours_check
    check (completed_hours between 0 and 24),
  add constraint registrations_attendance_hours_check
    check (attendance_status = 'present' or (completed_hours = 0 and not hours_confirmed));

create table if not exists public.organisation_verification_reviews (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  reviewer_user_id uuid not null references public.profiles(id),
  verification_status text not null check (verification_status in ('approved', 'rejected', 'more_information_required')),
  feedback text,
  internal_notes text,
  created_at timestamptz not null default now(),
  check (verification_status = 'approved' or nullif(trim(feedback), '') is not null)
);
create index if not exists organisation_verification_reviews_org_created_idx
  on public.organisation_verification_reviews(organisation_id, created_at desc);
alter table public.organisation_verification_reviews enable row level security;
revoke all on public.organisation_verification_reviews from public, anon, authenticated;
grant select on public.organisation_verification_reviews to authenticated;
drop policy if exists organisation_verification_reviews_admin_read on public.organisation_verification_reviews;
create policy organisation_verification_reviews_admin_read
  on public.organisation_verification_reviews for select to authenticated
  using (public.is_admin());

drop policy if exists organisations_public_approved on public.organisations;
drop policy if exists organisations_owner_or_admin_select on public.organisations;
create policy organisations_owner_or_admin_select
  on public.organisations for select to authenticated
  using (owner_user_id = auth.uid() or public.is_admin());
revoke select on public.organisations from anon;
grant select on public.organisations to authenticated;

create table if not exists public.organisation_verification_documents (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null check (char_length(file_name) between 1 and 180),
  content_type text not null check (content_type in ('application/pdf', 'image/jpeg', 'image/png')),
  file_size_bytes integer not null check (file_size_bytes between 1 and 10485760),
  uploaded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  check (storage_path like uploaded_by::text || '/%')
);
create index if not exists organisation_verification_documents_org_idx
  on public.organisation_verification_documents(organisation_id, created_at desc);
alter table public.organisation_verification_documents enable row level security;
revoke all on public.organisation_verification_documents from public, anon, authenticated;
grant select, insert, delete on public.organisation_verification_documents to authenticated;
grant all on public.organisation_verification_documents to service_role;
drop policy if exists organisation_verification_documents_owner_read on public.organisation_verification_documents;
drop policy if exists organisation_verification_documents_owner_insert on public.organisation_verification_documents;
drop policy if exists organisation_verification_documents_owner_delete on public.organisation_verification_documents;
drop policy if exists organisation_verification_documents_admin_read on public.organisation_verification_documents;
create policy organisation_verification_documents_owner_read
  on public.organisation_verification_documents for select to authenticated
  using (exists (select 1 from public.organisations o where o.id = organisation_id and o.owner_user_id = auth.uid()));
create policy organisation_verification_documents_admin_read
  on public.organisation_verification_documents for select to authenticated
  using (public.is_admin());
create policy organisation_verification_documents_owner_insert
  on public.organisation_verification_documents for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and public.current_user_role() = 'organisation'
    and public.is_verified_user()
    and exists (select 1 from public.organisations o where o.id = organisation_id and o.owner_user_id = auth.uid())
  );
create policy organisation_verification_documents_owner_delete
  on public.organisation_verification_documents for delete to authenticated
  using (uploaded_by = auth.uid() and exists (select 1 from public.organisations o where o.id = organisation_id and o.owner_user_id = auth.uid()));

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('verification-documents', 'verification-documents', false, 10485760, array['application/pdf','image/jpeg','image/png'])
on conflict (id) do update set public = false, file_size_limit = 10485760, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists verification_documents_owner_insert on storage.objects;
drop policy if exists verification_documents_owner_read on storage.objects;
drop policy if exists verification_documents_owner_delete on storage.objects;
drop policy if exists verification_documents_admin_read on storage.objects;
create policy verification_documents_owner_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'verification-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.current_user_role() = 'organisation'
    and public.is_verified_user()
  );
create policy verification_documents_owner_read
  on storage.objects for select to authenticated
  using (bucket_id = 'verification-documents' and (storage.foldername(name))[1] = auth.uid()::text);
create policy verification_documents_owner_delete
  on storage.objects for delete to authenticated
  using (bucket_id = 'verification-documents' and (storage.foldername(name))[1] = auth.uid()::text);
create policy verification_documents_admin_read
  on storage.objects for select to authenticated
  using (bucket_id = 'verification-documents' and public.is_admin());

create table if not exists public.registration_attendance_audit (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.registrations(id) on delete cascade,
  actor_user_id uuid not null references public.profiles(id),
  previous_values jsonb not null,
  new_values jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists registration_attendance_audit_registration_idx
  on public.registration_attendance_audit(registration_id, created_at desc);
alter table public.registration_attendance_audit enable row level security;
revoke all on public.registration_attendance_audit from public, anon, authenticated;
grant select on public.registration_attendance_audit to authenticated;
grant all on public.registration_attendance_audit to service_role;
drop policy if exists registration_attendance_audit_select_permitted on public.registration_attendance_audit;
create policy registration_attendance_audit_select_permitted
  on public.registration_attendance_audit for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.registrations r
      where r.id = registration_id
        and (r.volunteer_id = auth.uid() or exists (
          select 1 from public.events e join public.organisations o on o.id = e.organisation_id
          where e.id = r.event_id and o.owner_user_id = auth.uid()
        ))
    )
  );

revoke insert, update, delete on public.registrations from public, anon, authenticated;
grant select on public.registrations to authenticated;

alter table public.registration_attendance_audit
  drop constraint if exists registration_attendance_audit_registration_id_fkey;
alter table public.registration_attendance_audit
  add constraint registration_attendance_audit_registration_id_fkey
  foreign key (registration_id) references public.registrations(id) on delete restrict;

create index if not exists events_required_skills_gin_idx on public.events using gin(required_skills);
create index if not exists profiles_skills_gin_idx on public.profiles using gin(skills);

revoke update on public.profiles from public, anon, authenticated;
grant update (full_name, phone, location, skills, interests, preferred_categories, province, city, service_area, available_days, available_time_start, available_time_end, availability_notes, experience, participation_type, preferred_distance_km, share_with_organisations) on public.profiles to authenticated;
grant select, update on public.profiles to service_role;

grant update (province, city, address, service_area) on public.organisations to authenticated;
grant update (required_skills, participation_type, eligibility, application_deadline) on public.events to authenticated;

create or replace function public.submit_organisation_verification(p_organisation_id uuid)
returns public.organisations
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare target public.organisations; updated public.organisations;
begin
  if not public.is_verified_user() or public.current_user_role() <> 'organisation' then
    raise exception using errcode = '42501', message = 'A verified organisation account is required';
  end if;
  select * into target from public.organisations where id = p_organisation_id and owner_user_id = auth.uid() for update;
  if target.id is null then raise exception using errcode = 'P0002', message = 'Organisation not found'; end if;
  if target.verification_status = 'approved' then
    raise exception using errcode = 'P0001', message = 'Your organisation is already approved';
  end if;
  update public.organisations
  set verification_status = 'pending', verification_feedback = null,
      verification_submitted_at = now(), verification_reviewed_at = null, verification_reviewed_by = null
  where id = p_organisation_id returning * into updated;
  return updated;
end;
$$;

create or replace function public.review_organisation_verification(
  p_organisation_id uuid,
  p_status text,
  p_feedback text default null,
  p_internal_notes text default null
)
returns public.organisations
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare target public.organisations; owner_profile public.profiles; updated public.organisations;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Administrator access is required';
  end if;
  if p_status not in ('approved', 'rejected', 'more_information_required') then
    raise exception using errcode = '22023', message = 'Invalid organisation verification decision';
  end if;
  if p_status <> 'approved' and nullif(trim(p_feedback), '') is null then
    raise exception using errcode = '22023', message = 'Feedback is required for this decision';
  end if;
  select * into target from public.organisations where id = p_organisation_id for update;
  if target.id is null then raise exception using errcode = 'P0002', message = 'Organisation not found'; end if;
  select * into owner_profile from public.profiles where id = target.owner_user_id for update;
  if not exists (select 1 from auth.users where id = owner_profile.id and email_confirmed_at is not null) then
    raise exception using errcode = 'P0001', message = 'The organisation must verify its email first';
  end if;
  update public.organisations
  set verification_status = p_status,
      approval_status = case when p_status = 'approved' then 'approved'::public.approval_status else 'pending'::public.approval_status end,
      verification_feedback = nullif(trim(p_feedback), ''),
      verification_reviewed_at = now(), verification_reviewed_by = auth.uid(),
      reviewed_at = now(), reviewed_by = auth.uid()
  where id = p_organisation_id returning * into updated;
  if owner_profile.account_status <> 'suspended' then
    update public.profiles
    set account_status = 'active',
        approved_at = case when p_status = 'approved' then now() else null end,
        approved_by = case when p_status = 'approved' then auth.uid() else null end
    where id = target.owner_user_id;
  end if;
  insert into public.organisation_verification_reviews(organisation_id, reviewer_user_id, verification_status, feedback, internal_notes)
  values (target.id, auth.uid(), p_status, nullif(trim(p_feedback), ''), nullif(trim(p_internal_notes), ''));
  return updated;
end;
$$;

revoke all on function public.submit_organisation_verification(uuid) from public, anon;
revoke all on function public.review_organisation_verification(uuid, text, text, text) from public, anon;
grant execute on function public.submit_organisation_verification(uuid) to authenticated;
grant execute on function public.review_organisation_verification(uuid, text, text, text) to authenticated;

drop function if exists public.record_registration_attendance(uuid, public.attendance_status);
create or replace function public.record_registration_attendance(
  p_registration_id uuid,
  p_attendance_status text,
  p_completed_hours numeric default 0,
  p_hours_confirmed boolean default false
)
returns public.registrations
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare reg public.registrations; target public.events; updated public.registrations;
begin
  if not public.is_verified_user() or public.current_user_role() <> 'organisation'
    or public.current_account_status() <> 'active'
    or not exists (select 1 from public.organisations where owner_user_id = auth.uid() and approval_status = 'approved') then
    raise exception using errcode = '42501', message = 'Only verified, approved organisations can record attendance';
  end if;
  if p_attendance_status not in ('present', 'absent', 'excused') then
    raise exception using errcode = '22023', message = 'Attendance must be present, absent, or excused';
  end if;
  if p_completed_hours is null or p_completed_hours < 0 or p_completed_hours > 24 then
    raise exception using errcode = '22023', message = 'Completed hours must be between 0 and 24';
  end if;
  if p_attendance_status <> 'present' and (p_completed_hours <> 0 or p_hours_confirmed) then
    raise exception using errcode = '22023', message = 'Only attended volunteers can have confirmed hours';
  end if;
  select * into reg from public.registrations where id = p_registration_id for update;
  if reg.id is null then raise exception using errcode = 'P0002', message = 'Registration not found'; end if;
  select * into target from public.events where id = reg.event_id for update;
  if not exists (select 1 from public.organisations where id = target.organisation_id and owner_user_id = auth.uid() and approval_status = 'approved') then
    raise exception using errcode = '42501', message = 'You can only manage your own event attendance';
  end if;
  if reg.status not in ('accepted', 'attended') then
    raise exception using errcode = 'P0001', message = 'Only accepted volunteers are eligible for attendance';
  end if;
  if target.event_date > current_date then
    raise exception using errcode = 'P0001', message = 'Attendance can be recorded on or after the event date';
  end if;
  update public.registrations
  set attendance_status = p_attendance_status,
      status = case when p_attendance_status = 'present' then 'attended' else 'accepted' end,
      completed_hours = case when p_attendance_status = 'present' then p_completed_hours else 0 end,
      hours_confirmed = case when p_attendance_status = 'present' then p_hours_confirmed else false end,
      attendance_updated_by = auth.uid(), attendance_updated_at = now()
  where id = p_registration_id returning * into updated;
  insert into public.registration_attendance_audit(registration_id, actor_user_id, previous_values, new_values)
  values (
    updated.id, auth.uid(),
    jsonb_build_object('attendance_status', reg.attendance_status, 'completed_hours', reg.completed_hours, 'hours_confirmed', reg.hours_confirmed),
    jsonb_build_object('attendance_status', updated.attendance_status, 'completed_hours', updated.completed_hours, 'hours_confirmed', updated.hours_confirmed)
  );
  return updated;
end;
$$;
revoke all on function public.record_registration_attendance(uuid, text, numeric, boolean) from public, anon;
grant execute on function public.record_registration_attendance(uuid, text, numeric, boolean) to authenticated;

drop function if exists public.get_organisation_volunteer_applications();
create function public.get_organisation_volunteer_applications()
returns table (
  id uuid,
  organisation_id uuid,
  volunteer_id uuid,
  application_message text,
  status public.organisation_application_status,
  applied_at timestamptz,
  updated_at timestamptz,
  full_name text,
  email text,
  location text,
  skills text[],
  interests text[],
  preferred_categories text[],
  province text,
  city text,
  service_area text,
  available_days text[],
  available_time_start time,
  available_time_end time,
  availability_notes text,
  experience text,
  participation_type text
)
language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  if not public.is_verified_user() or public.current_user_role() <> 'organisation'
    or public.current_account_status() not in ('active', 'pending') then
    raise exception using errcode = '42501', message = 'Only verified organisation accounts can view applications';
  end if;
  return query
    select a.id, a.organisation_id, a.volunteer_id, a.application_message, a.status,
      a.applied_at, a.updated_at, p.full_name, p.email, p.location,
      case when p.share_with_organisations then p.skills else '{}'::text[] end,
      case when p.share_with_organisations then p.interests else '{}'::text[] end,
      case when p.share_with_organisations then p.preferred_categories else '{}'::text[] end,
      case when p.share_with_organisations then p.province else null end,
      case when p.share_with_organisations then p.city else null end,
      case when p.share_with_organisations then p.service_area else null end,
      case when p.share_with_organisations then p.available_days else '{}'::text[] end,
      case when p.share_with_organisations then p.available_time_start else null end,
      case when p.share_with_organisations then p.available_time_end else null end,
      case when p.share_with_organisations then p.availability_notes else null end,
      case when p.share_with_organisations then p.experience else null end,
      case when p.share_with_organisations then p.participation_type else null end
    from public.organisation_applications a
    join public.organisations o on o.id = a.organisation_id
    join public.profiles p on p.id = a.volunteer_id
    where o.owner_user_id = auth.uid() and public.is_approved_organisation(o.id)
    order by a.applied_at desc;
end;
$$;
revoke all on function public.get_organisation_volunteer_applications() from public, anon;
grant execute on function public.get_organisation_volunteer_applications() to authenticated;

create or replace function public.apply_to_event(p_event_id uuid, p_message text default null)
returns public.registrations
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare target public.events; existing public.registrations; accepted_count integer; created public.registrations;
begin
  if auth.uid() is null or not public.is_verified_user()
    or public.current_user_role() <> 'volunteer' or public.current_account_status() <> 'active' then
    raise exception using errcode = '42501', message = 'Only verified, active volunteers can apply';
  end if;
  select * into target from public.events where id = p_event_id for update;
  if target.id is null then raise exception using errcode = 'P0002', message = 'Event not found'; end if;
  if target.status <> 'published' or (target.event_date + target.start_time) <= localtimestamp
    or (target.application_deadline is not null and target.application_deadline < current_date) then
    raise exception using errcode = 'P0001', message = 'This event is not accepting applications';
  end if;
  select * into existing from public.registrations where event_id = p_event_id and volunteer_id = auth.uid() for update;
  if existing.id is not null and existing.status not in ('withdrawn', 'rejected') then
    raise exception using errcode = '23505', message = 'You have already applied to this event';
  end if;
  select count(*) into accepted_count from public.registrations where event_id = p_event_id and status in ('accepted', 'attended');
  if accepted_count >= target.capacity then raise exception using errcode = 'P0001', message = 'This event is full'; end if;
  if existing.id is not null then
    update public.registrations set application_message = p_message, status = 'pending', attendance_status = 'not_recorded', completed_hours = 0, hours_confirmed = false where id = existing.id returning * into created;
  else
    insert into public.registrations (event_id, volunteer_id, application_message) values (p_event_id, auth.uid(), p_message) returning * into created;
  end if;
  return created;
end;
$$;
revoke all on function public.apply_to_event(uuid, text) from public, anon;
grant execute on function public.apply_to_event(uuid, text) to authenticated;
