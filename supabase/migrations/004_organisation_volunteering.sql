do $$ begin
  if not exists (select 1 from pg_type where typname = 'organisation_application_status') then
    create type public.organisation_application_status as enum ('pending', 'accepted', 'rejected', 'withdrawn');
  end if;
end $$;

create table if not exists public.organisation_applications (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  volunteer_id uuid not null references public.profiles(id) on delete cascade,
  application_message text check (application_message is null or char_length(application_message) <= 1000),
  status public.organisation_application_status not null default 'pending',
  applied_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organisation_id, volunteer_id)
);

create index if not exists organisation_applications_volunteer_idx
  on public.organisation_applications(volunteer_id, applied_at desc);
create index if not exists organisation_applications_organisation_idx
  on public.organisation_applications(organisation_id, applied_at desc);

drop trigger if exists organisation_applications_updated_at on public.organisation_applications;
create trigger organisation_applications_updated_at
  before update on public.organisation_applications
  for each row execute function public.set_updated_at();

alter table public.organisation_applications enable row level security;
drop policy if exists organisation_applications_select_permitted on public.organisation_applications;
create policy organisation_applications_select_permitted
  on public.organisation_applications for select to authenticated
  using (
    public.is_verified_user()
    and public.current_account_status() = 'active'
    and (
      volunteer_id = auth.uid()
      or exists (
        select 1 from public.organisations o
        where o.id = organisation_id
          and o.owner_user_id = auth.uid()
          and public.is_approved_organisation(o.id)
      )
      or public.is_admin()
    )
  );

revoke all on public.organisation_applications from public, anon, authenticated;
grant select on public.organisation_applications to authenticated;
grant all on public.organisation_applications to service_role;

create or replace function public.apply_to_organisation(p_organisation_id uuid, p_message text default null)
returns public.organisation_applications
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  existing public.organisation_applications;
  created public.organisation_applications;
begin
  if auth.uid() is null or not public.is_verified_user()
    or public.current_user_role() <> 'volunteer'
    or public.current_account_status() <> 'active' then
    raise exception using errcode = '42501', message = 'Only active, verified volunteers can apply';
  end if;
  if p_message is not null and char_length(p_message) > 1000 then
    raise exception using errcode = '22023', message = 'Application message is too long';
  end if;
  if not public.is_approved_organisation(p_organisation_id) then
    raise exception using errcode = 'P0002', message = 'Organisation not found';
  end if;

  select * into existing from public.organisation_applications
  where organisation_id = p_organisation_id and volunteer_id = auth.uid()
  for update;
  if existing.id is not null and existing.status not in ('withdrawn', 'rejected') then
    raise exception using errcode = '23505', message = 'You have already applied to this organisation';
  end if;

  if existing.id is not null then
    update public.organisation_applications
    set application_message = p_message, status = 'pending', applied_at = timezone('utc', now())
    where id = existing.id returning * into created;
  else
    insert into public.organisation_applications (organisation_id, volunteer_id, application_message)
    values (p_organisation_id, auth.uid(), p_message) returning * into created;
  end if;
  return created;
end;
$$;

create or replace function public.update_organisation_application_status(
  p_application_id uuid,
  p_status public.organisation_application_status
)
returns public.organisation_applications
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  application public.organisation_applications;
  updated public.organisation_applications;
begin
  if not public.is_verified_user() or public.current_user_role() <> 'organisation'
    or public.current_account_status() <> 'active' then
    raise exception using errcode = '42501', message = 'Only active, verified organisations can manage applications';
  end if;
  if p_status not in ('accepted', 'rejected') then
    raise exception using errcode = '22023', message = 'Invalid application decision';
  end if;
  select * into application from public.organisation_applications
  where id = p_application_id for update;
  if application.id is null then
    raise exception using errcode = 'P0002', message = 'Application not found';
  end if;
  if not exists (
    select 1 from public.organisations
    where id = application.organisation_id and owner_user_id = auth.uid()
      and public.is_approved_organisation(id)
  ) then
    raise exception using errcode = '42501', message = 'You can only manage applications for your organisation';
  end if;
  if application.status <> 'pending' then
    raise exception using errcode = 'P0001', message = 'This application is no longer awaiting a decision';
  end if;
  update public.organisation_applications set status = p_status
  where id = p_application_id returning * into updated;
  return updated;
end;
$$;

create or replace function public.withdraw_organisation_application(p_application_id uuid)
returns public.organisation_applications
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  application public.organisation_applications;
  updated public.organisation_applications;
begin
  if not public.is_verified_user() or public.current_user_role() <> 'volunteer'
    or public.current_account_status() <> 'active' then
    raise exception using errcode = '42501', message = 'Only active, verified volunteers can withdraw applications';
  end if;
  select * into application from public.organisation_applications
  where id = p_application_id for update;
  if application.id is null or application.volunteer_id <> auth.uid() then
    raise exception using errcode = '42501', message = 'You can only withdraw your own application';
  end if;
  if application.status not in ('pending', 'accepted') then
    raise exception using errcode = 'P0001', message = 'This application cannot be withdrawn';
  end if;
  update public.organisation_applications set status = 'withdrawn'
  where id = p_application_id returning * into updated;
  return updated;
end;
$$;

create or replace function public.get_organisation_volunteer_applications()
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
  location text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.is_verified_user() or public.current_user_role() <> 'organisation'
    or public.current_account_status() <> 'active' then
    raise exception using errcode = '42501', message = 'Only active, verified organisations can view applications';
  end if;
  return query
    select a.id, a.organisation_id, a.volunteer_id, a.application_message, a.status,
      a.applied_at, a.updated_at, p.full_name, p.email, p.location
    from public.organisation_applications a
    join public.organisations o on o.id = a.organisation_id
    join public.profiles p on p.id = a.volunteer_id
    where o.owner_user_id = auth.uid()
      and public.is_approved_organisation(o.id)
    order by a.applied_at desc;
end;
$$;

revoke all on function public.apply_to_organisation(uuid, text) from public, anon;
revoke all on function public.update_organisation_application_status(uuid, public.organisation_application_status) from public, anon;
revoke all on function public.withdraw_organisation_application(uuid) from public, anon;
revoke all on function public.get_organisation_volunteer_applications() from public, anon;
grant execute on function public.apply_to_organisation(uuid, text) to authenticated;
grant execute on function public.update_organisation_application_status(uuid, public.organisation_application_status) to authenticated;
grant execute on function public.withdraw_organisation_application(uuid) to authenticated;
grant execute on function public.get_organisation_volunteer_applications() to authenticated;
