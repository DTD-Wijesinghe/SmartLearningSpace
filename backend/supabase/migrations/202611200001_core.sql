begin;
create schema sls;
revoke all on schema sls from public, anon, authenticated;

create table sls.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  name text not null check (length(name) between 1 and 160),
  role text not null check (role in ('admin', 'teacher', 'student')),
  pending boolean not null default false,
  suspended boolean not null default false
);
create table sls.courses (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references sls.profiles(id),
  title text not null check (length(btrim(title)) between 1 and 160),
  status text not null default 'draft' check (status in ('draft', 'published', 'suspended'))
);
create index courses_owner on sls.courses(owner);
create table sls.lessons (
  id uuid primary key default gen_random_uuid(),
  course uuid not null references sls.courses(id),
  title text not null check (length(btrim(title)) between 1 and 160),
  body text not null check (length(btrim(body)) between 1 and 12000),
  created_at timestamptz not null default now(),
  unique (id, course)
);
create index lessons_course on sls.lessons(course);
create table sls.enrollments (
  course uuid references sls.courses(id),
  student uuid references sls.profiles(id),
  primary key (course, student)
);
create index enrollments_student on sls.enrollments(student);
create table sls.progress (
  course uuid not null,
  student uuid not null,
  lesson uuid not null,
  primary key (course, student, lesson),
  foreign key (course, student) references sls.enrollments(course, student),
  foreign key (lesson, course) references sls.lessons(id, course)
);
create table sls.audit (
  id bigint generated always as identity primary key,
  actor uuid not null,
  action text not null,
  target uuid not null,
  created_at timestamptz not null default now()
);
alter table sls.profiles enable row level security;
alter table sls.courses enable row level security;
alter table sls.lessons enable row level security;
alter table sls.enrollments enable row level security;
alter table sls.progress enable row level security;
alter table sls.audit enable row level security;

create function sls.create_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
declare wants_teacher boolean := new.raw_user_meta_data->>'teacher' = 'true';
begin
  wants_teacher := coalesce(wants_teacher, false);
  insert into sls.profiles (id, email, name, role, pending)
  values (new.id, lower(new.email),
    coalesce(nullif(left(btrim(new.raw_user_meta_data->>'name'), 160), ''), 'Learner'),
    case when wants_teacher then 'teacher' else 'student' end, wants_teacher);
  return new;
end $$;
revoke all on function sls.create_profile() from public;
create trigger sls_profile after insert on auth.users for each row execute function sls.create_profile();

create function sls.course_summary(c sls.courses, viewer uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', c.id, 'title', c.title, 'status', c.status,
    'teacher', (select name from sls.profiles where id = c.owner),
    'lessonCount', (select count(*) from sls.lessons where course = c.id),
    'enrolled', exists (select 1 from sls.enrollments where course = c.id and student = viewer),
    'progress', coalesce((select round(100.0 * count(p.lesson) / nullif(count(l.id), 0))
      from sls.lessons l left join sls.progress p on p.lesson = l.id and p.student = viewer
      where l.course = c.id), 0))
$$;
revoke all on function sls.course_summary(sls.courses, uuid) from public;

-- Access to the private schema goes through this authenticated, action-specific API.
create function public.sls_workspace(action text, payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me sls.profiles;
  selected sls.courses;
  target_id uuid;
  user_json jsonb;
  owns boolean;
  enrolled boolean;
  summaries jsonb;
begin
  select * into me from sls.profiles where id = auth.uid() for share;
  if not found or me.pending or me.suspended then
    raise exception using errcode = '42501', message = 'Account unavailable.';
  end if;
  user_json := jsonb_build_object('email', me.email, 'name', me.name, 'role', me.role);
  if action = 'me' then return jsonb_build_object('user', user_json); end if;

  if action in ('dashboard', 'courses') then
    select coalesce(jsonb_agg(sls.course_summary(c, me.id) order by c.title, c.id), '[]'::jsonb)
      into summaries from sls.courses c
      where me.role = 'admin' or (me.role = 'teacher' and c.owner = me.id)
        or (me.role = 'student' and c.status = 'published');
    if action = 'courses' then return jsonb_build_object('courses', summaries); end if;
    return jsonb_build_object('user', user_json, 'stats', case me.role
      when 'admin' then jsonb_build_object('Accounts', (select count(*) from sls.profiles),
        'Pending teachers', (select count(*) from sls.profiles where pending), 'Courses', jsonb_array_length(summaries))
      when 'teacher' then jsonb_build_object('My courses', jsonb_array_length(summaries),
        'Enrollments', (select count(*) from sls.enrollments e join sls.courses c on c.id = e.course where c.owner = me.id))
      else jsonb_build_object('Available courses', jsonb_array_length(summaries),
        'My enrollments', (select count(*) from sls.enrollments e join sls.courses c on c.id = e.course
          where e.student = me.id and c.status = 'published')) end);
  end if;

  if action in ('users', 'approve', 'suspension') then
    if me.role <> 'admin' then raise insufficient_privilege using message = 'Administrator access required.'; end if;
    if action = 'users' then
      return jsonb_build_object('users', coalesce((select jsonb_agg(to_jsonb(p) - 'id' order by p.name)
        from sls.profiles p), '[]'::jsonb));
    end if;
    if action = 'approve' then
      update sls.profiles set pending = false where email = payload->>'email' and role = 'teacher' and pending returning id into target_id;
    else
      if jsonb_typeof(payload->'suspended') is distinct from 'boolean' then
        raise invalid_parameter_value using message = 'Choose a suspension state.';
      end if;
      update sls.profiles set suspended = (payload->>'suspended')::boolean
        where email = payload->>'email' and role <> 'admin' returning id into target_id;
    end if;
    if target_id is null then raise sqlstate 'PT404' using message = 'Account not found.'; end if;
    insert into sls.audit(actor, action, target) values (me.id, action, target_id);
    return jsonb_build_object('ok', true);
  end if;

  if action = 'create' then
    if me.role <> 'teacher' then raise insufficient_privilege using message = 'Teacher access required.'; end if;
    insert into sls.courses(owner, title) values (me.id, btrim(payload->>'title')) returning * into selected;
    return jsonb_build_object('course', sls.course_summary(selected, me.id));
  end if;

  select * into selected from sls.courses where id = (payload->>'courseId')::uuid;
  if action <> 'course' and found then
    select * into selected from sls.courses where id = selected.id for update;
  end if;
  owns := me.role = 'teacher' and selected.owner = me.id;
  if selected.id is null or not (owns or me.role = 'admin' or (me.role = 'student' and selected.status = 'published')) then
    raise sqlstate 'PT404' using message = 'Course not found.';
  end if;
  enrolled := exists (select 1 from sls.enrollments where course = selected.id and student = me.id);
  if action = 'course' then
    return jsonb_build_object('course', sls.course_summary(selected, me.id),
      'lessons', case when owns or me.role = 'admin' or enrolled then coalesce((select jsonb_agg(
        jsonb_build_object('id', l.id, 'title', l.title, 'text', l.body) order by l.created_at, l.id)
        from sls.lessons l where l.course = selected.id), '[]'::jsonb) else '[]'::jsonb end,
      'students', case when owns then coalesce((select jsonb_agg(jsonb_build_object('name', p.name) order by p.name)
        from sls.enrollments e join sls.profiles p on p.id = e.student where e.course = selected.id), '[]'::jsonb) end,
      'completed', coalesce((select jsonb_agg(lesson) from sls.progress where course = selected.id and student = me.id), '[]'::jsonb));
  end if;
  if action = 'enroll' and me.role = 'student' then
    insert into sls.enrollments(course, student) values (selected.id, me.id) on conflict do nothing;
  elsif action = 'progress' and me.role = 'student' and enrolled then
    insert into sls.progress(course, student, lesson) values (selected.id, me.id, (payload->>'lessonId')::uuid) on conflict do nothing;
  elsif action = 'edit' and owns and selected.status <> 'suspended' then
    update sls.courses set title = btrim(payload->>'title') where id = selected.id returning * into selected;
  elsif action = 'lessons' and owns and selected.status <> 'suspended' then
    insert into sls.lessons(course, title, body) values (selected.id, btrim(payload->>'title'), btrim(payload->>'text'));
  elsif action = 'publish' and owns and selected.status = 'draft' then
    if not exists (select 1 from sls.lessons where course = selected.id) then
      raise sqlstate 'PT409' using message = 'Add a lesson before publishing.';
    end if;
    update sls.courses set status = 'published' where id = selected.id returning * into selected;
  elsif action = 'suspend' and me.role = 'admin' and selected.status = 'published' then
    update sls.courses set status = 'suspended' where id = selected.id returning * into selected;
    insert into sls.audit(actor, action, target) values (me.id, action, selected.id);
  else
    raise insufficient_privilege using message = 'This action is unavailable for your account or course.';
  end if;
  return jsonb_build_object('course', sls.course_summary(selected, me.id));
end $$;
revoke all on function public.sls_workspace(text,jsonb) from public, anon, authenticated;
grant execute on function public.sls_workspace(text,jsonb) to authenticated;
commit;
