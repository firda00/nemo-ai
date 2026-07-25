alter table public.business_profiles
  add column if not exists company_email text,
  add column if not exists employee_count text;
