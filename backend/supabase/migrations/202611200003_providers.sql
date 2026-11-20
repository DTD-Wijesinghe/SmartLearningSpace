begin;
create table sls.module_assets (
  id uuid primary key default gen_random_uuid(),
  course uuid not null references sls.courses(id),
  lesson uuid not null,
  name text not null check (length(name) between 1 and 160),
  mime text not null,
  size_bytes bigint not null check (size_bytes between 1 and 2147483648),
  ready_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (lesson,course) references sls.lessons(id,course)
);
create index module_assets_course on sls.module_assets(course);
alter table sls.module_assets enable row level security;

create table sls.live_sessions (
  id uuid primary key default gen_random_uuid(),
  course uuid not null references sls.courses(id),
  title text not null check (length(title) between 1 and 160),
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create unique index module_single_live_room on sls.live_sessions(course) where ended_at is null;
alter table sls.live_sessions enable row level security;

create table sls.ai_usage (
  day date not null,
  user_id uuid not null references sls.profiles(id),
  calls integer not null check (calls between 1 and 12),
  primary key(day, user_id)
);
alter table sls.ai_usage enable row level security;

-- The provider API calls this function with the signed-in user's token.
-- Clients receive object IDs and room IDs only after the same database checks.
create function public.sls_module_services(action text, payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me sls.profiles;
  c sls.courses;
  file sls.module_assets;
  live sls.live_sessions;
  owner_access boolean;
  learner_access boolean;
  requested_size bigint;
  requested_type text;
  usage_day date := (now() at time zone 'UTC')::date;
begin
  if action is null then raise invalid_parameter_value using message = 'Choose an action.'; end if;
  select * into me from sls.profiles where id = auth.uid() for share;
  if not found or me.pending or me.suspended then raise insufficient_privilege using message = 'Account unavailable.'; end if;
  if action = 'ai_quota' then
    perform pg_advisory_xact_lock(379215733);
    if (select coalesce(sum(calls),0) from sls.ai_usage where day = usage_day) >= 100 then
      raise sqlstate 'PT429' using message = 'The learning assistant has reached its daily limit.';
    end if;
    insert into sls.ai_usage(day,user_id,calls) values(usage_day,me.id,1)
    on conflict(day,user_id) do update set calls = sls.ai_usage.calls + 1 where sls.ai_usage.calls < 12;
    if not found then raise sqlstate 'PT429' using message = 'You reached the daily assistant limit.'; end if;
    return jsonb_build_object('allowed',true);
  end if;

  select * into c from sls.courses where id = (payload->>'courseId')::uuid for share;
  if not found then raise sqlstate 'PT404' using message = 'Module not found.'; end if;
  owner_access := me.role = 'teacher' and c.owner = me.id and c.status <> 'suspended';
  learner_access := me.role = 'student' and c.status = 'published'
    and exists(select 1 from sls.enrollments where course = c.id and student = me.id);
  if not owner_access and not learner_access then
    raise insufficient_privilege using message = 'Only the teacher and enrolled learners can access these services.';
  end if;
  if action = 'list' then
    return jsonb_build_object(
      'assets',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from sls.module_assets a
         where a.course = c.id and (owner_access or a.ready_at is not null)),'[]'::jsonb),
      'live',(select to_jsonb(l) from sls.live_sessions l where l.course = c.id and l.ended_at is null));
  elsif action in ('get_asset','verify_asset') then
    if action = 'verify_asset' and not owner_access then raise insufficient_privilege using message = 'Only the module owner can verify uploads.'; end if;
    select * into file from sls.module_assets where id = (payload->>'assetId')::uuid and course = c.id and (owner_access or ready_at is not null);
    if not found then raise sqlstate 'PT404' using message = 'Material not found.'; end if;
    return to_jsonb(file);
  elsif action = 'join_live' then
    select * into live from sls.live_sessions where course = c.id and ended_at is null;
    if not found then raise sqlstate 'PT404' using message = 'No active class.'; end if;
    return jsonb_build_object('session',live.id,'identity',me.id,'name',me.name,'host',owner_access);
  elsif not owner_access then
    raise insufficient_privilege using message = 'Only the module owner can make this change.';
  end if;

  if action = 'reserve_asset' then
    requested_type := payload->>'mime';
    requested_size := (payload->>'size')::bigint;
    if requested_type is null or requested_type not in ('application/pdf','text/plain','image/png','image/jpeg','video/mp4','video/webm',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') then
      raise invalid_parameter_value using message = 'File type is unsupported.';
    end if;
    if requested_size is null or requested_size < 1 or requested_size > (case when requested_type like 'video/%' then 2147483648 else 20971520 end) then
      raise invalid_parameter_value using message = 'File is too large or empty.';
    end if;
    perform pg_advisory_xact_lock(379215734);
    if (select coalesce(sum(size_bytes),0) from sls.module_assets) + requested_size > 8589934592
      or (select count(*) from sls.module_assets) >= 500 then raise sqlstate 'PT409' using message = 'Material storage quota reached.'; end if;
    if (select coalesce(sum(a.size_bytes),0) from sls.module_assets a join sls.courses co on co.id=a.course where co.owner=me.id) + requested_size > 4294967296
      then raise sqlstate 'PT409' using message = 'Teacher storage quota reached.'; end if;
    insert into sls.module_assets(course,lesson,name,mime,size_bytes)
    values(c.id,(payload->>'lessonId')::uuid,btrim(payload->>'name'),requested_type,requested_size) returning * into file;
    return to_jsonb(file);
  elsif action = 'start_live' then
    if c.status <> 'published' then raise sqlstate 'PT409' using message = 'Publish this module first.'; end if;
    insert into sls.live_sessions(course,title) values(c.id,btrim(payload->>'title'))
      on conflict(course) where ended_at is null do nothing;
    select * into live from sls.live_sessions where course = c.id and ended_at is null;
    return to_jsonb(live);
  elsif action = 'end_live' then
    update sls.live_sessions set ended_at = now() where course = c.id and id = (payload->>'session')::uuid and ended_at is null;
    if not found then raise sqlstate 'PT409' using message = 'This class already ended.'; end if;
    return jsonb_build_object('ended',true);
  end if;
  raise sqlstate 'PT404' using message = 'Unknown module operation.';
end $$;
revoke all on function public.sls_module_services(text,jsonb) from public, anon, authenticated;
grant execute on function public.sls_module_services(text,jsonb) to authenticated;

-- Only the API's server credential may attest to an actual object upload.
create function public.sls_confirm_material(asset_id uuid, expected_mime text, expected_bytes bigint) returns boolean
language sql security definer set search_path = '' as $$
  with updated as (
    update sls.module_assets set ready_at = coalesce(ready_at,now())
    where id = asset_id and mime = expected_mime and size_bytes = expected_bytes
    returning id
  ) select exists(select 1 from updated)
$$;
revoke all on function public.sls_confirm_material(uuid,text,bigint) from public, anon, authenticated;
grant execute on function public.sls_confirm_material(uuid,text,bigint) to service_role;
commit;
