begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table sls.module_enrollment_codes (
  course uuid primary key references sls.courses(id) on delete cascade,
  code_hash text not null
);
alter table sls.module_enrollment_codes enable row level security;
revoke all on sls.module_enrollment_codes from public, anon, authenticated;

alter function public.sls_workspace(text,jsonb) set schema sls;
alter function sls.sls_workspace(text,jsonb) rename to workspace_before_enrollment_codes;
revoke all on function sls.workspace_before_enrollment_codes(text,jsonb) from public, anon, authenticated;

create function public.sls_workspace(action text, payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me sls.profiles := sls.billing_user();
  module_id uuid := nullif(payload->>'courseId','')::uuid;
  code text := btrim(payload->>'enrollmentCode');
  valid_code boolean := coalesce(jsonb_typeof(payload->'enrollmentCode') = 'string'
    and code ~ '^[A-Za-z0-9_-]{12,48}$', false);
  response jsonb;
  saved_hash text;
begin
  if action = 'enroll' and me.role = 'student' then
    -- Match the underlying profile/course lock order and serialize code rotation with enrollment.
    perform from sls.profiles where id = me.id for share;
    perform from sls.courses where id = module_id and status = 'published' for update;
    if not found then raise sqlstate 'PT404' using message = 'Module not found.'; end if;
    if not exists(select from sls.enrollments where course = module_id and student = me.id) then
      select code_hash into saved_hash from sls.module_enrollment_codes where course = module_id;
      if saved_hash is null then
        raise sqlstate 'PT409' using message = 'Ask your teacher to set an enrollment code for this module.';
      end if;
      if not valid_code or extensions.crypt(code, saved_hash) is distinct from saved_hash then
        raise insufficient_privilege using message = 'Enter the correct enrollment code from your teacher.';
      end if;
    end if;
  end if;

  response := sls.workspace_before_enrollment_codes(action, payload - 'enrollmentCode');

  if me.role = 'teacher' and (action = 'create' or (action = 'edit' and payload ? 'enrollmentCode' and code is distinct from '')) then
    if not valid_code then
      raise sqlstate 'PT422' using message = 'Use 12–48 letters, numbers, hyphens, or underscores for the enrollment code.';
    end if;
    insert into sls.module_enrollment_codes(course, code_hash)
      values (case when action = 'edit' then module_id else (response->'course'->>'id')::uuid end,
        extensions.crypt(code, extensions.gen_salt('bf', 10)))
    on conflict (course) do update set code_hash = excluded.code_hash;
  end if;

  if action = 'course' and me.role = 'teacher' then
    response := jsonb_set(response, '{course,enrollmentCodeSet}', to_jsonb(exists(
      select from sls.module_enrollment_codes where course = module_id)), true);
  end if;
  return response;
end $$;

create or replace function public.sls_module_page(action text,payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p sls.profiles := sls.billing_user();
  module_id uuid := (payload->>'courseId')::uuid;
  response jsonb;
begin
  if p.role='teacher' and sls.member_access(p,null)<=now() then
    raise sqlstate 'PT402' using message='Renew your teacher access to use this feature.';
  end if;
  if p.role='student' and sls.member_access(p,module_id)<=now() then
    if exists(select from sls.enrollments where course=module_id and student=p.id) then
      if action<>'read' then
        raise sqlstate 'PT402' using message='Pay your course fee to access this feature.';
      end if;
    elsif action='read' and exists(select from sls.courses where id=module_id and status='published') then
      return '{"outline":[],"conversations":[],"assets":[]}';
    end if;
    response := sls.page_before_billing(action,payload);
    return response || '{"conversations":[],"assets":[]}';
  end if;
  return sls.page_before_billing(action,payload);
end $$;

revoke all on function public.sls_workspace(text,jsonb) from public, anon, authenticated;
grant execute on function public.sls_workspace(text,jsonb) to authenticated;

commit;
