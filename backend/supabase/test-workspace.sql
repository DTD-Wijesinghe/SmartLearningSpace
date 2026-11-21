-- Run inside a disposable test database or with SQL-editor administrator access.
-- Test records are rolled back, even after a successful run.
begin;
insert into auth.users(id,email,raw_user_meta_data) values
  ('b1078ff5-c2ad-4213-930b-46fd00a10001','admin-fixture@example.test','{"name":"QA Admin"}'),
  ('b1078ff5-c2ad-4213-930b-46fd00a10002','teacher-fixture@example.test','{"name":"QA Teacher","teacher":true}'),
  ('b1078ff5-c2ad-4213-930b-46fd00a10003','student-fixture@example.test','{"name":"QA Student","role":"admin"}');
update sls.profiles set role = 'admin' where email = 'admin-fixture@example.test';
update sls.profiles set pending = true where email = 'teacher-fixture@example.test';
set local role authenticated;
do $$
declare
  teacher text := 'b1078ff5-c2ad-4213-930b-46fd00a10002';
  student text := 'b1078ff5-c2ad-4213-930b-46fd00a10003';
  course jsonb;
  other_course jsonb;
  lesson_id text;
  view_data jsonb;
begin
  assert not has_schema_privilege(current_user, 'sls', 'USAGE');
  assert not has_function_privilege('anon', 'public.sls_workspace(text,jsonb)', 'EXECUTE');
  perform set_config('request.jwt.claim.sub', teacher, true);
  begin
    perform public.sls_workspace('me');
    raise exception 'Pending teacher received access';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claim.sub', 'b1078ff5-c2ad-4213-930b-46fd00a10001', true);
  perform public.sls_workspace('approve','{"email":"teacher-fixture@example.test"}');
  perform set_config('request.jwt.claim.sub', teacher, true);
  begin
    perform public.sls_workspace('create','{"title":"Missing code"}');
    raise exception 'Module was created without a code';
  exception when sqlstate 'PT422' then null;
  end;
  course := jsonb_build_object('courseId', public.sls_workspace('create','{"enrollmentCode":"FixtureCode-26","title":"QA Course"}')->'course'->>'id');
  other_course := jsonb_build_object('courseId',public.sls_workspace('create','{"enrollmentCode":"OtherFixture-29","title":"Other course"}')->'course'->>'id');
  perform public.sls_workspace('lessons', course || '{"title":"QA Lesson","text":"Protected test text"}');
  if public.sls_workspace('course',course)->'course'->>'status' = 'draft' then
    perform public.sls_workspace('publish', course);
  end if;
  perform set_config('request.jwt.claim.sub', student, true);
  assert public.sls_workspace('me')->'user'->>'role' = 'student';
  begin
    perform public.sls_workspace('users');
    raise exception 'Student received account list';
  exception when insufficient_privilege then null;
  end;
  assert public.sls_workspace('course', course)->'lessons' = '[]';
  assert not (public.sls_workspace('course', course)->'course' ? 'enrollmentCodeSet');
  begin
    perform public.sls_workspace('enroll', course);
    raise exception 'Student enrolled without a code';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.sls_workspace('enroll', other_course || '{"enrollmentCode":"FixtureCode-26"}');
    raise exception 'Student enrolled using another module code';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claim.sub', teacher, true);
  perform public.sls_workspace('edit', course || '{"title":"QA Course","enrollmentCode":"Replacement-82"}');
  perform set_config('request.jwt.claim.sub', student, true);
  begin
    perform public.sls_workspace('enroll', course || '{"enrollmentCode":"FixtureCode-26"}');
    raise exception 'Student enrolled using a replaced code';
  exception when insufficient_privilege then null;
  end;
  perform public.sls_workspace('enroll',course || '{"enrollmentCode":"Replacement-82"}');
  perform public.sls_workspace('enroll',course || '{"enrollmentCode":"FixtureCode-26"}');
  view_data := public.sls_workspace('course', course);
  assert view_data->'lessons'->0->>'text' = 'Protected test text';
  lesson_id := view_data->'lessons'->0->>'id';
  perform public.sls_workspace('progress', course || jsonb_build_object('lessonId', lesson_id));
  assert (public.sls_workspace('course', course)->'course'->>'progress')::numeric = 100;
  perform set_config('request.jwt.claim.sub', teacher, true);
  assert jsonb_array_length(public.sls_workspace('course', course)->'students') = 1;
end $$;
rollback;
