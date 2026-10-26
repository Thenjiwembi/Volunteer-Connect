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
grant update (name, description, registration_number, contact_email, contact_phone, location, website)
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
