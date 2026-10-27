alter table public.organisations add column if not exists image_url text;

grant update (name, description, registration_number, contact_email, contact_phone, location, website, image_url)
  on public.organisations to authenticated;