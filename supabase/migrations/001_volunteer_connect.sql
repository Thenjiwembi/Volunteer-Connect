create extension if not exists pgcrypto;

do $$ begin if not exists (select 1 from pg_type where typname = 'app_role') then create type public.app_role as enum ('volunteer', 'organisation', 'admin'); end if; end $$;
do $$ begin if not exists (select 1 from pg_type where typname = 'account_status') then create type public.account_status as enum ('active', 'pending', 'suspended'); end if; end $$;
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
  location text not null, website text,
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
