-- Volunteer Connect complete schema for a fresh Supabase project.
-- Run this file once in the Supabase SQL Editor (or with psql) to create the
-- tables, types, functions, triggers, permissions, and RLS policies.
-- Do not run this file on an existing installation; apply migrations in order.
-- Never add service-role secrets or real user data to this file.

create extension if not exists pgcrypto;

do $$ begin if not exists (select 1 from pg_type where typname = 'app_role') then create type public.app_role as enum ('volunteer', 'organisation', 'admin'); end if; end $$;
do $$ begin if not exists (select 1 from pg_type where typname = 'account_status') then create type public.account_status as enum ('active', 'pending', 'suspended', 'rejected'); end if; end $$;
do $$ begin if not exists (select 1 from pg_type where typname = 'approval_status') then create type public.approval_status as enum ('pending', 'approved', 'rejected'); end if; end $$;
do $$ begin if not exists (select 1 from pg_type where typname = 'event_status') then create type public.event_status as enum ('draft', 'published', 'cancelled', 'completed'); end if; end $$;
do $$ begin if not exists (select 1 from pg_type where typname = 'registration_status') then create type public.registration_status as enum ('pending', 'accepted', 'rejected', 'withdrawn', 'attended'); end if; end $$;
do $$ begin if not exists (select 1 from pg_type where typname = 'attendance_status') then create type public.attendance_status as enum ('not_recorded', 'present', 'absent'); end if; end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null check (char_length(trim(full_name)) >= 2),
  email text not null,
  phone text,
  location text,
  role public.app_role not null default 'volunteer',
  account_status public.account_status not null default 'active',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);
create table if not exists public.organisations (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.profiles(id) on delete cascade unique,
  name text not null check (char_length(trim(name)) >= 2), description text,
  registration_number text, contact_email text not null, contact_phone text,
  location text not null, website text, image_url text,
  approval_status public.approval_status not null default 'pending',
  reviewed_by uuid references public.profiles(id) on delete set null, reviewed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()), updated_at timestamptz not null default timezone('utc', now())
);
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  title text not null check (char_length(trim(title)) >= 5), description text not null,
  category text not null, location text not null, event_date date not null,
  start_time time not null, end_time time not null, capacity integer not null check (capacity > 0),
  status public.event_status not null default 'draft',
  created_at timestamptz not null default timezone('utc', now()), updated_at timestamptz not null default timezone('utc', now()),
  constraint event_time_order check (end_time > start_time)
);
create table if not exists public.registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  volunteer_id uuid not null references public.profiles(id) on delete cascade,
  application_message text, status public.registration_status not null default 'pending',
  attendance_status public.attendance_status not null default 'not_recorded',
  applied_at timestamptz not null default timezone('utc', now()), updated_at timestamptz not null default timezone('utc', now()),
  unique (event_id, volunteer_id)
);

create index if not exists events_date_idx on public.events(event_date);
create index if not exists events_status_idx on public.events(status);
create index if not exists events_organisation_idx on public.events(organisation_id);
create index if not exists registrations_event_idx on public.registrations(event_id);
create index if not exists registrations_volunteer_idx on public.registrations(volunteer_id);
create index if not exists registrations_status_idx on public.registrations(status);

create or replace function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = timezone('utc', now()); return new; end; $$;
drop trigger if exists profiles_updated_at on public.profiles;
drop trigger if exists organisations_updated_at on public.organisations;
drop trigger if exists events_updated_at on public.events;
drop trigger if exists registrations_updated_at on public.registrations;
create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger organisations_updated_at before update on public.organisations for each row execute function public.set_updated_at();
create trigger events_updated_at before update on public.events for each row execute function public.set_updated_at();
create trigger registrations_updated_at before update on public.registrations for each row execute function public.set_updated_at();

create or replace function public.current_user_role() returns public.app_role language sql stable security definer set search_path = public as $$ select role from public.profiles where id = auth.uid(); $$;
create or replace function public.current_account_status() returns public.account_status language sql stable security definer set search_path = public as $$ select account_status from public.profiles where id = auth.uid(); $$;
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$ select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and account_status = 'active'); $$;
create or replace function public.is_org_owner(p_organisation_id uuid) returns boolean language sql stable security definer set search_path = public as $$ select exists (select 1 from public.organisations where id = p_organisation_id and owner_user_id = auth.uid()); $$;

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare requested_role text := coalesce(new.raw_user_meta_data->>'role', 'volunteer');
begin
  if requested_role not in ('volunteer', 'organisation') then requested_role := 'volunteer'; end if;
  insert into public.profiles (id, full_name, email, role) values (new.id, coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), 'New member'), new.email, requested_role::public.app_role);
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.prevent_owner_approval_change() returns trigger language plpgsql as $$
begin
  if not public.is_admin() and old.owner_user_id = auth.uid() and (new.approval_status is distinct from old.approval_status or new.reviewed_by is distinct from old.reviewed_by or new.reviewed_at is distinct from old.reviewed_at) then
    raise exception using errcode = '42501', message = 'Only an administrator can change organisation approval';
  end if;
  return new;
end;
$$;
drop trigger if exists organisation_approval_guard on public.organisations;
create trigger organisation_approval_guard before update on public.organisations for each row execute function public.prevent_owner_approval_change();

create or replace function public.validate_event_status_transition() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and not (
    (old.status = 'draft' and new.status in ('draft', 'published', 'cancelled')) or
    (old.status = 'published' and new.status in ('published', 'cancelled', 'completed')) or
    (old.status = 'cancelled' and new.status = 'cancelled') or
    (old.status = 'completed' and new.status = 'completed')
  ) then
    raise exception using errcode = 'P0001', message = 'Invalid event status transition';
  end if;
  if new.status = 'published' and (new.event_date + new.start_time) <= localtimestamp then
    raise exception using errcode = 'P0001', message = 'Published events must be in the future';
  end if;
  return new;
end;
$$;
drop trigger if exists event_status_guard on public.events;
create trigger event_status_guard before insert or update on public.events for each row execute function public.validate_event_status_transition();

create or replace function public.apply_to_event(p_event_id uuid, p_message text default null)
returns public.registrations language plpgsql security definer set search_path = public as $$
declare target public.events; existing public.registrations; accepted_count integer; created public.registrations;
begin
  if auth.uid() is null or public.current_user_role() <> 'volunteer' or public.current_account_status() <> 'active' then raise exception using errcode = '42501', message = 'Only active volunteers can apply'; end if;
  select * into target from public.events where id = p_event_id for update;
  if target.id is null then raise exception using errcode = 'P0002', message = 'Event not found'; end if;
  if target.status <> 'published' or (target.event_date + target.start_time) <= localtimestamp then raise exception using errcode = 'P0001', message = 'This event is not accepting applications'; end if;
  select * into existing from public.registrations where event_id = p_event_id and volunteer_id = auth.uid() for update;
  if existing.id is not null and existing.status not in ('withdrawn', 'rejected') then raise exception using errcode = '23505', message = 'You have already applied to this event'; end if;
  select count(*) into accepted_count from public.registrations where event_id = p_event_id and status in ('accepted', 'attended');
  if accepted_count >= target.capacity then raise exception using errcode = 'P0001', message = 'This event is full'; end if;
  if existing.id is not null then update public.registrations set application_message = p_message, status = 'pending', attendance_status = 'not_recorded' where id = existing.id returning * into created;
  else insert into public.registrations (event_id, volunteer_id, application_message) values (p_event_id, auth.uid(), p_message) returning * into created; end if;
  return created;
end;
$$;

create or replace function public.update_registration_status(p_registration_id uuid, p_status public.registration_status)
returns public.registrations language plpgsql security definer set search_path = public as $$
declare reg public.registrations; target public.events; org_id uuid; accepted_count integer; updated public.registrations;
begin
  if public.current_user_role() <> 'organisation' or public.current_account_status() <> 'active' then raise exception using errcode = '42501', message = 'Only active organisations can manage applications'; end if;
  select * into reg from public.registrations where id = p_registration_id for update;
  if reg.id is null then raise exception using errcode = 'P0002', message = 'Application not found'; end if;
  select * into target from public.events where id = reg.event_id for update;
  select organisation_id into org_id from public.organisations where id = target.organisation_id and owner_user_id = auth.uid();
  if org_id is null then raise exception using errcode = '42501', message = 'You can only manage your own event applications'; end if;
  if reg.status <> 'pending' and p_status <> 'withdrawn' then raise exception using errcode = 'P0001', message = 'This application is no longer awaiting a decision'; end if;
  if p_status = 'accepted' then
    select count(*) into accepted_count from public.registrations where event_id = reg.event_id and status in ('accepted', 'attended');
    if accepted_count >= target.capacity then raise exception using errcode = 'P0001', message = 'This event is full'; end if;
  end if;
  update public.registrations set status = p_status where id = p_registration_id returning * into updated;
  return updated;
end;
$$;

create or replace function public.record_registration_attendance(p_registration_id uuid, p_attendance_status public.attendance_status)
returns public.registrations language plpgsql security definer set search_path = public as $$
declare reg public.registrations; target public.events; is_owner boolean; updated public.registrations;
begin
  if public.current_user_role() <> 'organisation' or public.current_account_status() <> 'active' then raise exception using errcode = '42501', message = 'Only active organisations can record attendance'; end if;
  select * into reg from public.registrations where id = p_registration_id for update;
  if reg.id is null then raise exception using errcode = 'P0002', message = 'Application not found'; end if;
  select * into target from public.events where id = reg.event_id for update;
  select exists (select 1 from public.organisations where id = target.organisation_id and owner_user_id = auth.uid()) into is_owner;
  if not is_owner then raise exception using errcode = '42501', message = 'You can only manage your own event attendance'; end if;
  if reg.status not in ('accepted', 'attended') then raise exception using errcode = 'P0001', message = 'Only accepted volunteers can be marked present or absent'; end if;
  if target.event_date > current_date then raise exception using errcode = 'P0001', message = 'Attendance can be recorded on or after the event date'; end if;
  update public.registrations set attendance_status = p_attendance_status, status = case when p_attendance_status = 'present' then 'attended' else 'accepted' end where id = p_registration_id returning * into updated;
  return updated;
end;
$$;

create or replace function public.withdraw_registration(p_registration_id uuid)
returns public.registrations language plpgsql security definer set search_path = public as $$
declare reg public.registrations; updated public.registrations;
begin
  if public.current_user_role() <> 'volunteer' or public.current_account_status() <> 'active' then raise exception using errcode = '42501', message = 'Only active volunteers can withdraw'; end if;
  select * into reg from public.registrations where id = p_registration_id for update;
  if reg.id is null or reg.volunteer_id <> auth.uid() then raise exception using errcode = '42501', message = 'You can only withdraw your own application'; end if;
  if reg.status not in ('pending', 'accepted') then raise exception using errcode = 'P0001', message = 'This application cannot be withdrawn'; end if;
  update public.registrations set status = 'withdrawn' where id = p_registration_id returning * into updated;
  return updated;
end;
$$;

grant execute on function public.apply_to_event(uuid, text) to authenticated;
grant execute on function public.update_registration_status(uuid, public.registration_status) to authenticated;
grant execute on function public.record_registration_attendance(uuid, public.attendance_status) to authenticated;
grant execute on function public.withdraw_registration(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.organisations enable row level security;
alter table public.events enable row level security;
alter table public.registrations enable row level security;

drop policy if exists profiles_select_self_or_admin on public.profiles;
drop policy if exists profiles_update_self on public.profiles;
drop policy if exists profiles_admin_update on public.profiles;
drop policy if exists organisations_public_approved on public.organisations;
drop policy if exists organisations_owner_insert on public.organisations;
drop policy if exists organisations_owner_update on public.organisations;
drop policy if exists organisations_admin_update on public.organisations;
drop policy if exists events_public_published on public.events;
drop policy if exists events_owner_write on public.events;
drop policy if exists events_admin_write on public.events;
drop policy if exists registrations_select_permitted on public.registrations;

create policy profiles_select_self_or_admin on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin());
create policy profiles_update_self on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid() and role = public.current_user_role() and account_status = public.current_account_status());
create policy profiles_admin_update on public.profiles for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy organisations_public_approved on public.organisations for select to anon, authenticated using (approval_status = 'approved' or owner_user_id = auth.uid() or public.is_admin());
create policy organisations_owner_insert on public.organisations for insert to authenticated with check (owner_user_id = auth.uid() and public.current_user_role() = 'organisation' and approval_status = 'pending' and reviewed_by is null and reviewed_at is null);
create policy organisations_owner_update on public.organisations for update to authenticated using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy organisations_admin_update on public.organisations for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy events_public_published on public.events for select to anon, authenticated using ((status = 'published' and exists (select 1 from public.organisations o where o.id = organisation_id and o.approval_status = 'approved')) or public.is_org_owner(organisation_id) or public.is_admin());
create policy events_owner_write on public.events for all to authenticated using (public.is_org_owner(organisation_id)) with check (public.is_org_owner(organisation_id) and (status <> 'published' or exists (select 1 from public.organisations o where o.id = organisation_id and o.approval_status = 'approved')));
create policy events_admin_write on public.events for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy registrations_select_permitted on public.registrations for select to authenticated using (volunteer_id = auth.uid() or exists (select 1 from public.events e where e.id = event_id and public.is_org_owner(e.organisation_id)) or public.is_admin());

-- Account verification and approval safeguards.
alter table public.profiles
  add column if not exists approved_at timestamptz,
  add column if not exists email_verified_at timestamptz,
  add column if not exists approved_by uuid references public.profiles(id) on delete set null;

alter table public.profiles alter column account_status set default 'pending';
update public.profiles p
set email_verified_at = u.email_confirmed_at
from auth.users u
where u.id = p.id;
update public.profiles
set approved_at = created_at
where role <> 'admin' and account_status = 'suspended' and approved_at is null;
update public.profiles
set account_status = 'pending', approved_at = null, approved_by = null
where role <> 'admin' and account_status = 'active';

create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references public.profiles(id),
  target_user_id uuid references public.profiles(id) on delete set null,
  action text not null check (action in ('account_approved', 'account_rejected', 'account_suspended', 'account_reactivated')),
  previous_status public.account_status,
  next_status public.account_status,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_log_target_created_idx
  on public.admin_audit_log(target_user_id, created_at desc);

create or replace function public.is_verified_user()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from auth.users
    where id = auth.uid() and email_confirmed_at is not null
  );
$$;

revoke all on function public.is_verified_user() from public, anon;
grant execute on function public.is_verified_user() to authenticated;

create or replace function public.current_user_role()
returns public.app_role
language sql
stable
security definer
set search_path = pg_catalog, public
as $$ select role from public.profiles where id = auth.uid(); $$;

create or replace function public.current_account_status()
returns public.account_status
language sql
stable
security definer
set search_path = pg_catalog, public
as $$ select account_status from public.profiles where id = auth.uid(); $$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$ select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and account_status = 'active') and public.is_verified_user(); $$;

create or replace function public.is_org_owner(p_organisation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$ select exists (select 1 from public.organisations where id = p_organisation_id and owner_user_id = auth.uid()); $$;

create or replace function public.is_approved_organisation(p_organisation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.organisations o
    join public.profiles p on p.id = o.owner_user_id
    where o.id = p_organisation_id
      and o.approval_status = 'approved'
      and p.role = 'organisation'
      and p.account_status = 'active'
  );
$$;

revoke all on function public.is_approved_organisation(uuid) from public;
grant execute on function public.is_approved_organisation(uuid) to anon, authenticated;

create or replace function public.apply_to_event(p_event_id uuid, p_message text default null)
returns public.registrations
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target public.events;
  existing public.registrations;
  accepted_count integer;
  created public.registrations;
begin
  if not public.is_verified_user() or public.current_user_role() <> 'volunteer' or public.current_account_status() <> 'active' then
    raise exception using errcode = '42501', message = 'Only verified, active volunteers can apply';
  end if;
  select * into target from public.events where id = p_event_id for update;
  if target.id is null then raise exception using errcode = 'P0002', message = 'Event not found'; end if;
  if target.status <> 'published' or (target.event_date + target.start_time) <= localtimestamp then
    raise exception using errcode = 'P0001', message = 'This event is not accepting applications';
  end if;
  select * into existing from public.registrations where event_id = p_event_id and volunteer_id = auth.uid() for update;
  if existing.id is not null and existing.status not in ('withdrawn', 'rejected') then
    raise exception using errcode = '23505', message = 'You have already applied to this event';
  end if;
  select count(*) into accepted_count from public.registrations where event_id = p_event_id and status in ('accepted', 'attended');
  if accepted_count >= target.capacity then raise exception using errcode = 'P0001', message = 'This event is full'; end if;
  if existing.id is not null then
    update public.registrations
    set application_message = p_message, status = 'pending', attendance_status = 'not_recorded'
    where id = existing.id returning * into created;
  else
    insert into public.registrations (event_id, volunteer_id, application_message)
    values (p_event_id, auth.uid(), p_message) returning * into created;
  end if;
  return created;
end;
$$;

create or replace function public.update_registration_status(p_registration_id uuid, p_status public.registration_status)
returns public.registrations
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  reg public.registrations;
  target public.events;
  org_id uuid;
  accepted_count integer;
  updated public.registrations;
begin
  if not public.is_verified_user()
    or public.current_user_role() <> 'organisation'
    or public.current_account_status() <> 'active'
    or not exists (
      select 1 from public.organisations
      where owner_user_id = auth.uid() and approval_status = 'approved'
    ) then
    raise exception using errcode = '42501', message = 'Only verified, approved organisations can manage applications';
  end if;
  select * into reg from public.registrations where id = p_registration_id for update;
  if reg.id is null then raise exception using errcode = 'P0002', message = 'Application not found'; end if;
  select * into target from public.events where id = reg.event_id for update;
  select organisation_id into org_id from public.organisations
  where id = target.organisation_id and owner_user_id = auth.uid() and approval_status = 'approved';
  if org_id is null then raise exception using errcode = '42501', message = 'You can only manage your own approved organisation applications'; end if;
  if reg.status <> 'pending' and p_status <> 'withdrawn' then
    raise exception using errcode = 'P0001', message = 'This application is no longer awaiting a decision';
  end if;
  if p_status = 'accepted' then
    select count(*) into accepted_count from public.registrations where event_id = reg.event_id and status in ('accepted', 'attended');
    if accepted_count >= target.capacity then raise exception using errcode = 'P0001', message = 'This event is full'; end if;
  end if;
  update public.registrations set status = p_status where id = p_registration_id returning * into updated;
  return updated;
end;
$$;

create or replace function public.record_registration_attendance(p_registration_id uuid, p_attendance_status public.attendance_status)
returns public.registrations
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  reg public.registrations;
  target public.events;
  is_owner boolean;
  updated public.registrations;
begin
  if not public.is_verified_user()
    or public.current_user_role() <> 'organisation'
    or public.current_account_status() <> 'active'
    or not exists (
      select 1 from public.organisations
      where owner_user_id = auth.uid() and approval_status = 'approved'
    ) then
    raise exception using errcode = '42501', message = 'Only verified, approved organisations can record attendance';
  end if;
  select * into reg from public.registrations where id = p_registration_id for update;
  if reg.id is null then raise exception using errcode = 'P0002', message = 'Application not found'; end if;
  select * into target from public.events where id = reg.event_id for update;
  select exists (
    select 1 from public.organisations
    where id = target.organisation_id and owner_user_id = auth.uid() and approval_status = 'approved'
  ) into is_owner;
  if not is_owner then raise exception using errcode = '42501', message = 'You can only manage your own approved event attendance'; end if;
  if reg.status not in ('accepted', 'attended') then
    raise exception using errcode = 'P0001', message = 'Only accepted volunteers can be marked present or absent';
  end if;
  if target.event_date > current_date then raise exception using errcode = 'P0001', message = 'Attendance can be recorded on or after the event date'; end if;
  update public.registrations
  set attendance_status = p_attendance_status,
      status = case when p_attendance_status = 'present' then 'attended' else 'accepted' end
  where id = p_registration_id returning * into updated;
  return updated;
end;
$$;

create or replace function public.withdraw_registration(p_registration_id uuid)
returns public.registrations
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  reg public.registrations;
  updated public.registrations;
begin
  if not public.is_verified_user() or public.current_user_role() <> 'volunteer' or public.current_account_status() <> 'active' then
    raise exception using errcode = '42501', message = 'Only verified, active volunteers can withdraw';
  end if;
  select * into reg from public.registrations where id = p_registration_id for update;
  if reg.id is null or reg.volunteer_id <> auth.uid() then
    raise exception using errcode = '42501', message = 'You can only withdraw your own application';
  end if;
  if reg.status not in ('pending', 'accepted') then
    raise exception using errcode = 'P0001', message = 'This application cannot be withdrawn';
  end if;
  update public.registrations set status = 'withdrawn' where id = p_registration_id returning * into updated;
  return updated;
end;
$$;

revoke all on function public.apply_to_event(uuid, text) from public, anon;
revoke all on function public.update_registration_status(uuid, public.registration_status) from public, anon;
revoke all on function public.record_registration_attendance(uuid, public.attendance_status) from public, anon;
revoke all on function public.withdraw_registration(uuid) from public, anon;
grant execute on function public.apply_to_event(uuid, text) to authenticated;
grant execute on function public.update_registration_status(uuid, public.registration_status) to authenticated;
grant execute on function public.record_registration_attendance(uuid, public.attendance_status) to authenticated;
grant execute on function public.withdraw_registration(uuid) to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.profiles (id, full_name, email, role, account_status, email_verified_at)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), 'New member'),
    new.email,
    'volunteer',
    'pending',
    new.email_confirmed_at
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function public.sync_auth_user_profile()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.profiles
  set email = new.email,
      email_verified_at = new.email_confirmed_at
  where id = new.id;
  return new;
end;
$$;

revoke all on function public.sync_auth_user_profile() from public, anon, authenticated;
drop trigger if exists on_auth_user_profile_email_update on auth.users;
create trigger on_auth_user_profile_email_update
  after update of email, email_confirmed_at on auth.users
  for each row
  when (old.email is distinct from new.email or old.email_confirmed_at is distinct from new.email_confirmed_at)
  execute function public.sync_auth_user_profile();

create or replace function public.review_account(p_user_id uuid, p_decision text)
returns public.profiles
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target public.profiles;
  next_status public.account_status;
  result public.profiles;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Administrator access is required';
  end if;
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception using errcode = '22023', message = 'Decision must be approved or rejected';
  end if;

  select p.* into target
  from public.profiles p
  where p.id = p_user_id
  for update;

  if target.id is null or target.role = 'admin' or target.id = auth.uid() then
    raise exception using errcode = '42501', message = 'This account cannot be reviewed';
  end if;
  if target.role = 'organisation' and not exists (
    select 1 from public.organisations where owner_user_id = target.id
  ) then
    raise exception using errcode = 'P0001', message = 'Organisation details are required before review';
  end if;
  if not exists (
    select 1 from auth.users u
    where u.id = target.id and u.email_confirmed_at is not null
  ) then
    raise exception using errcode = 'P0001', message = 'The user must verify their email before approval';
  end if;
  if target.account_status not in ('pending', 'active', 'rejected') then
    raise exception using errcode = 'P0001', message = 'This account cannot be reviewed in its current state';
  end if;

  next_status := case when p_decision = 'approved' then 'active'::public.account_status else 'rejected'::public.account_status end;

  update public.profiles
  set account_status = next_status,
      approved_at = case when next_status = 'active' then now() else null end,
      approved_by = case when next_status = 'active' then auth.uid() else null end
  where id = target.id
  returning * into result;

  if target.role = 'organisation' then
    update public.organisations
    set approval_status = p_decision::public.approval_status,
        reviewed_by = auth.uid(),
        reviewed_at = now()
    where owner_user_id = target.id;
  end if;

  insert into public.admin_audit_log(actor_user_id, target_user_id, action, previous_status, next_status)
  values (
    auth.uid(),
    target.id,
    case when next_status = 'active' then 'account_approved' else 'account_rejected' end,
    target.account_status,
    next_status
  );

  return result;
end;
$$;

create or replace function public.set_account_suspension(p_user_id uuid, p_suspend boolean)
returns public.profiles
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target public.profiles;
  next_status public.account_status;
  result public.profiles;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Administrator access is required';
  end if;
  if p_suspend is null then
    raise exception using errcode = '22023', message = 'Suspension action is required';
  end if;

  select p.* into target
  from public.profiles p
  where p.id = p_user_id
  for update;

  if target.id is null or target.role = 'admin' or target.id = auth.uid() then
    raise exception using errcode = '42501', message = 'This account cannot be changed';
  end if;

  if p_suspend then
    if target.account_status <> 'active' then
      raise exception using errcode = 'P0001', message = 'Only approved active accounts can be suspended';
    end if;
    next_status := 'suspended';
  else
    if target.account_status <> 'suspended' or target.approved_at is null then
      raise exception using errcode = 'P0001', message = 'Only previously approved accounts can be reactivated';
    end if;
    next_status := 'active';
  end if;

  update public.profiles set account_status = next_status where id = target.id returning * into result;

  insert into public.admin_audit_log(actor_user_id, target_user_id, action, previous_status, next_status)
  values (
    auth.uid(),
    target.id,
    case when p_suspend then 'account_suspended' else 'account_reactivated' end,
    target.account_status,
    next_status
  );

  return result;
end;
$$;

revoke all on function public.review_account(uuid, text) from public, anon;
revoke all on function public.set_account_suspension(uuid, boolean) from public, anon;
grant execute on function public.review_account(uuid, text) to authenticated;
grant execute on function public.set_account_suspension(uuid, boolean) to authenticated;

alter table public.admin_audit_log enable row level security;
drop policy if exists admin_audit_log_admin_read on public.admin_audit_log;
create policy admin_audit_log_admin_read
  on public.admin_audit_log for select to authenticated
  using (public.is_admin());
revoke all on public.admin_audit_log from public, anon, authenticated;
grant select on public.admin_audit_log to authenticated;

drop policy if exists organisations_public_approved on public.organisations;
create policy organisations_public_approved on public.organisations for select to anon, authenticated
using (
  public.is_approved_organisation(id)
  or owner_user_id = auth.uid()
  or public.is_admin()
);

drop policy if exists profiles_admin_update on public.profiles;
revoke update on public.profiles from public, anon, authenticated;
grant update (full_name, phone, location) on public.profiles to authenticated;
grant select, update on public.profiles to service_role;

drop policy if exists organisations_admin_update on public.organisations;
revoke update on public.organisations from public, anon, authenticated;
grant update (name, description, registration_number, contact_email, contact_phone, location, website, image_url)
  on public.organisations to authenticated;
grant insert, update on public.organisations to service_role;

drop policy if exists events_owner_write on public.events;
create policy events_owner_write on public.events for all to authenticated
using (
  public.is_verified_user()
  and
  public.current_account_status() = 'active'
  and public.is_org_owner(organisation_id)
  and exists (
    select 1 from public.organisations o
    where o.id = organisation_id and o.approval_status = 'approved'
  )
)
with check (
  public.is_verified_user()
  and
  public.current_account_status() = 'active'
  and public.is_org_owner(organisation_id)
  and exists (
    select 1 from public.organisations o
    where o.id = organisation_id and o.approval_status = 'approved'
  )
);

drop policy if exists registrations_select_permitted on public.registrations;
create policy registrations_select_permitted on public.registrations for select to authenticated
using (
  public.is_verified_user()
  and public.current_account_status() = 'active'
  and (
    volunteer_id = auth.uid()
    or exists (
      select 1 from public.events e
      where e.id = event_id
        and public.is_org_owner(e.organisation_id)
        and public.is_approved_organisation(e.organisation_id)
    )
    or public.is_admin()
  )
);

drop policy if exists events_public_published on public.events;
create policy events_public_published on public.events for select to anon, authenticated
using (
  (status = 'published' and public.is_approved_organisation(organisation_id))
  or public.is_org_owner(organisation_id)
  or public.is_admin()
);
