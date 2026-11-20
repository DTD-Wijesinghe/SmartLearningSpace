begin;
insert into auth.users(id,email,raw_user_meta_data) values
  ('b1078ff5-c2ad-4213-930b-46fd00a20001','module-owner@example.test','{"teacher":true,"name":"Module Owner"}'),
  ('b1078ff5-c2ad-4213-930b-46fd00a20002','module-student@example.test','{"name":"Module Student"}'),
  ('b1078ff5-c2ad-4213-930b-46fd00a20003','module-outsider@example.test','{"teacher":true,"name":"Other Teacher"}'),
  ('b1078ff5-c2ad-4213-930b-46fd00a20004','module-learner@example.test','{"name":"Other Student"}');
update sls.profiles set pending = false where email in ('module-owner@example.test','module-outsider@example.test');
set local role authenticated;
do $$
declare
  owner_id text := 'b1078ff5-c2ad-4213-930b-46fd00a20001';
  student_id text := 'b1078ff5-c2ad-4213-930b-46fd00a20002';
  course_ref jsonb;
  exam_ref jsonb;
  module jsonb;
begin
  perform set_config('request.jwt.claim.sub',owner_id,true);
  course_ref := jsonb_build_object('courseId',public.sls_workspace('create','{"title":"QA Module","subject":"Biology","description":"Module overview"}')->'course'->>'id');
  perform public.sls_workspace('edit',course_ref || '{"title":"Updated QA Module","subject":"Biology"}');
  perform public.sls_workspace('lessons',course_ref || '{"title":"Introduction","description":"Overview","text":"Lesson content"}');
  if public.sls_workspace('course',course_ref)->'course'->>'status' = 'draft' then
    perform public.sls_workspace('publish',course_ref);
  end if;
  perform public.sls_workspace('exam_create',course_ref || '{"title":"Check-in","questions":[{"prompt":"Pick A","options":["A","B"],"correct":0}]}');
  module := public.sls_workspace('course',course_ref);
  assert module->'history' @> '[{"snapshot":{"title":"QA Module"}},{"snapshot":{"title":"Updated QA Module"}}]'::jsonb;
  assert module->'course'->>'description' = 'Module overview';
  assert module->'lessons'->0->>'description' = 'Overview';
  exam_ref := course_ref || jsonb_build_object('examId',module->'exams'->0->>'id');

  perform set_config('request.jwt.claim.sub','b1078ff5-c2ad-4213-930b-46fd00a20003',true);
  begin
    perform public.sls_workspace('edit',course_ref || '{"title":"Forbidden"}');
    raise exception 'Other teacher edited a module';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claim.sub',student_id,true);
  assert public.sls_workspace('course',course_ref)->'exams' = '[]';
  begin
    perform public.sls_workspace('exam_submit',exam_ref || '{"answers":[0]}');
    raise exception 'Unenrolled student submitted an exam';
  exception when insufficient_privilege then null;
  end;
  perform public.sls_workspace('enroll',course_ref);
  module := public.sls_workspace('course',course_ref);
  assert not ((module->'exams'->0->'questions'->0) ? 'correct');
  perform public.sls_workspace('exam_submit',exam_ref || '{"answers":[0]}');
  assert public.sls_workspace('course',course_ref)->'exams'->0->'result' = 'null';
  begin
    perform public.sls_workspace('exam_submit',exam_ref || '{"answers":[1]}');
    raise exception 'Duplicate submission accepted';
  exception when sqlstate 'PT409' then null;
  end;
  begin
    perform public.sls_workspace(null,exam_ref || jsonb_build_object('studentId',student_id,'score',1));
    raise exception 'Null action accepted';
  exception when invalid_parameter_value then null;
  end;
  perform public.sls_workspace('progress',course_ref || jsonb_build_object('lessonId',module->'lessons'->0->>'id'));
  perform set_config('request.jwt.claim.sub',owner_id,true);
  module := public.sls_workspace('course',course_ref);
  assert module->'exams'->0->'submissions'->0->'answers' = '[0]';
  assert module->'exams'->0->'submissions'->0->>'score' = '1';
  assert module->'learnerProgress'->0->>'completed' = '1';
  perform public.sls_workspace('exam_release',exam_ref || jsonb_build_object('studentId',student_id,'score',1,'feedback','Well done'));
  perform set_config('request.jwt.claim.sub',student_id,true);
  assert public.sls_workspace('course',course_ref)->'exams'->0->'result'->>'feedback' = 'Well done';
  assert public.sls_workspace('course',course_ref)->'exams'->0->'submissions' = '[]';
  perform set_config('request.jwt.claim.sub','b1078ff5-c2ad-4213-930b-46fd00a20004',true);
  perform public.sls_workspace('enroll',course_ref);
  assert public.sls_workspace('course',course_ref)->'exams'->0->'result' = 'null';
end $$;
rollback;
