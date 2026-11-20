begin;
alter table sls.courses add column description text not null default '' check (length(description) <= 2000),
  add column subject text not null default '' check (length(subject) <= 100);
alter table sls.lessons add column description text not null default '' check (length(description) <= 1000);

create table sls.course_revisions (
  id bigint generated always as identity primary key,
  course uuid not null references sls.courses(id),
  actor uuid references sls.profiles(id),
  snapshot jsonb not null,
  recorded_at timestamptz not null default now()
);
create index course_revisions_course on sls.course_revisions(course, id desc);
alter table sls.course_revisions enable row level security;
insert into sls.course_revisions(course,actor,snapshot)
select id,null,jsonb_build_object('title',title,'subject',subject,'description',description,'status',status)
from sls.courses;
create function sls.record_course_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  insert into sls.course_revisions(course, actor, snapshot)
    values(new.id, auth.uid(), jsonb_build_object('title',new.title,'subject',new.subject,'description',new.description,'status',new.status));
  return new;
end $$;
revoke all on function sls.record_course_revision() from public;
create trigger record_course_revision after insert or update on sls.courses
  for each row execute function sls.record_course_revision();

create table sls.exams (
  id uuid primary key default gen_random_uuid(),
  course uuid not null references sls.courses(id),
  title text not null check (length(btrim(title)) between 1 and 160),
  questions jsonb not null,
  created_at timestamptz not null default now()
);
create index exams_course on sls.exams(course);
create table sls.exam_submissions (
  exam uuid not null references sls.exams(id),
  student uuid not null references sls.profiles(id),
  answers jsonb not null,
  score integer not null check (score >= 0 and score <= total),
  total integer not null check (total > 0),
  feedback text not null default '' check (length(feedback) <= 2000),
  released_at timestamptz,
  submitted_at timestamptz not null default now(),
  primary key (exam, student)
);
alter table sls.exams enable row level security;
alter table sls.exam_submissions enable row level security;

alter function public.sls_workspace(text,jsonb) set schema sls;
alter function sls.sls_workspace(text,jsonb) rename to workspace_v1;
revoke all on function sls.workspace_v1(text,jsonb) from public, anon, authenticated;

create function public.sls_workspace(action text, payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me sls.profiles;
  c sls.courses;
  e sls.exams;
  q jsonb;
  response jsonb;
  answers jsonb;
  total integer;
  points integer := 0;
  choice integer;
  step integer := 0;
  owner_access boolean;
  assessment_id uuid;
  score_value integer;
begin
  if action is null then raise invalid_parameter_value using message = 'Choose an action.'; end if;
  select * into me from sls.profiles where id = auth.uid() for share;
  if not found or me.pending or me.suspended then raise insufficient_privilege using message = 'Account unavailable.'; end if;

  if action = 'courses' then
    response := sls.workspace_v1(action,payload);
    return jsonb_build_object('courses',coalesce((select jsonb_agg(item || jsonb_build_object('description', course.description,'subject',course.subject) order by ord)
      from jsonb_array_elements(response->'courses') with ordinality as items(item,ord)
      join sls.courses course on course.id = (item->>'id')::uuid),'[]'::jsonb));
  elsif action = 'create' then
    if me.role <> 'teacher' then raise insufficient_privilege using message = 'Teacher access required.'; end if;
    insert into sls.courses(owner,title,description,subject)
      values(me.id,btrim(payload->>'title'),coalesce(btrim(payload->>'description'),''),coalesce(btrim(payload->>'subject'),''))
      returning * into c;
    return jsonb_build_object('course',sls.course_summary(c,me.id));
  elsif action not in ('course','edit','lessons','exam_create','exam_submit','exam_release') then
    return sls.workspace_v1(action,payload);
  end if;

  if action = 'course' then
    response := sls.workspace_v1(action,payload);
    select * into c from sls.courses where id = (payload->>'courseId')::uuid;
  else
    select * into c from sls.courses where id = (payload->>'courseId')::uuid for update;
  end if;
  if c.id is null then raise sqlstate 'PT404' using message = 'Course not found.'; end if;
  owner_access := me.role = 'teacher' and c.owner = me.id;
  if action = 'course' then
    return response || jsonb_build_object(
      'course',(response->'course') || jsonb_build_object('description',c.description,'subject',c.subject),
      'lessons',coalesce((select jsonb_agg(item || jsonb_build_object('description',l.description) order by ord)
         from jsonb_array_elements(response->'lessons') with ordinality as items(item,ord)
         join sls.lessons l on l.id = (item->>'id')::uuid),'[]'::jsonb),
      'history',case when owner_access then coalesce((select jsonb_agg(to_jsonb(r) - 'actor' - 'course' order by r.id desc)
         from (select * from sls.course_revisions where course = c.id order by id desc limit 15) r),'[]'::jsonb) else '[]'::jsonb end,
      'learnerProgress',case when owner_access then coalesce((select jsonb_agg(jsonb_build_object('name',p.name,
         'completed',(select count(*) from sls.progress pr where pr.student = p.id and pr.course = c.id)) order by p.name)
         from sls.enrollments en join sls.profiles p on p.id = en.student where en.course = c.id),'[]'::jsonb) else '[]'::jsonb end,
      'exams',case when owner_access or (me.role = 'student' and coalesce((response->'course'->>'enrolled')::boolean,false))
        then coalesce((select jsonb_agg(jsonb_build_object('id',exam.id,'title',exam.title,
          'questions',(select jsonb_agg(question - 'correct' order by ord) from jsonb_array_elements(exam.questions) with ordinality as fields(question,ord)),
          'submitted',exists(select 1 from sls.exam_submissions su where su.exam = exam.id and su.student = me.id),
          'result',(select jsonb_build_object('score',su.score,'total',su.total,'feedback',su.feedback) from sls.exam_submissions su
             where su.exam = exam.id and su.student = me.id and su.released_at is not null),
          'submissions',case when owner_access then coalesce((select jsonb_agg(jsonb_build_object('student',su.student,
              'name',p.name,'answers',su.answers,'score',su.score,'total',su.total,'released',su.released_at is not null,'feedback',su.feedback)
              order by su.submitted_at) from sls.exam_submissions su join sls.profiles p on p.id = su.student where su.exam = exam.id),'[]'::jsonb)
              else '[]'::jsonb end) order by exam.created_at) from sls.exams exam where exam.course = c.id),'[]'::jsonb) else '[]'::jsonb end);
  end if;

  if c.status = 'suspended' or (action <> 'exam_submit' and not owner_access) then
    raise insufficient_privilege using message = 'Only the module owner can make this change.';
  end if;
  if action = 'edit' then
    update sls.courses set title = btrim(payload->>'title'), description = coalesce(btrim(payload->>'description'),description),
      subject = coalesce(btrim(payload->>'subject'),subject) where id = c.id returning * into c;
  elsif action = 'lessons' then
    insert into sls.lessons(course,title,body,description)
      values(c.id,btrim(payload->>'title'),btrim(payload->>'text'),coalesce(btrim(payload->>'description'),''));
  elsif action = 'exam_create' then
    if jsonb_typeof(payload->'questions') is distinct from 'array' then raise invalid_parameter_value using message = 'Enter questions.'; end if;
    total := jsonb_array_length(payload->'questions');
    if total < 1 or total > 25 then raise invalid_parameter_value using message = 'Enter 1 to 25 questions.'; end if;
    for q in select value from jsonb_array_elements(payload->'questions') loop
      if jsonb_typeof(q->'options') is distinct from 'array' or jsonb_typeof(q->'correct') is distinct from 'number'
        or coalesce(length(btrim(q->>'prompt')),0) not between 1 and 500 then
        raise invalid_parameter_value using message = 'Enter a question, choices, and a correct choice.';
      end if;
      if jsonb_array_length(q->'options') not between 2 and 6 or (q->>'correct')::integer not between 0 and jsonb_array_length(q->'options')-1
        or exists(select 1 from jsonb_array_elements(q->'options') v where jsonb_typeof(v) <> 'string' or length(btrim(v#>>'{}')) not between 1 and 200)
        or exists(select 1 from jsonb_object_keys(q) k where k not in ('prompt','options','correct')) then
        raise invalid_parameter_value using message = 'Check the answer choices.';
      end if;
    end loop;
    insert into sls.exams(course,title,questions) values(c.id,btrim(payload->>'title'),payload->'questions');
  else
    assessment_id := (payload->>'examId')::uuid;
    select * into e from sls.exams where id = assessment_id and course = c.id;
    if not found then raise sqlstate 'PT404' using message = 'Exam not found.'; end if;
    if action = 'exam_submit' then
      if me.role <> 'student' or c.status <> 'published' or not exists(select 1 from sls.enrollments where course = c.id and student = me.id) then
        raise insufficient_privilege using message = 'Enroll in this module before submitting.';
      end if;
      answers := payload->'answers';
      total := jsonb_array_length(e.questions);
      if jsonb_typeof(answers) is distinct from 'array' or jsonb_array_length(answers) <> total then
        raise invalid_parameter_value using message = 'Answer every question.';
      end if;
      for q in select value from jsonb_array_elements(e.questions) loop
        if jsonb_typeof(answers->step) is distinct from 'number' then raise invalid_parameter_value using message = 'Choose one answer per question.'; end if;
        choice := (answers->>step)::integer;
        if choice not between 0 and jsonb_array_length(q->'options')-1 then raise invalid_parameter_value using message = 'Invalid choice.'; end if;
        if choice = (q->>'correct')::integer then points := points + 1; end if;
        step := step + 1;
      end loop;
      insert into sls.exam_submissions(exam,student,answers,score,total) values(e.id,me.id,answers,points,total)
        on conflict do nothing;
      if not found then raise sqlstate 'PT409' using message = 'This exam has already been submitted.'; end if;
      return jsonb_build_object('submitted',true);
    end if;
    score_value := (payload->>'score')::integer;
    update sls.exam_submissions set score = score_value, feedback = coalesce(btrim(payload->>'feedback'),''), released_at = now()
      where exam = e.id and student = (payload->>'studentId')::uuid and released_at is null;
    if not found then raise sqlstate 'PT409' using message = 'Submission is missing or has already been released.'; end if;
    insert into sls.audit(actor,action,target) values(me.id,'exam_release',e.id);
  end if;
  return jsonb_build_object('ok',true);
end $$;
revoke all on function public.sls_workspace(text,jsonb) from public, anon, authenticated;
grant execute on function public.sls_workspace(text,jsonb) to authenticated;
commit;
