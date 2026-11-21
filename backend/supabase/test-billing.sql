begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('bf2f73c1-441a-4df3-afc1-7037a8190081','billing-admin@example.test','{"name":"Admin"}'),
 ('bf2f73c1-441a-4df3-afc1-7037a8190082','billing-owner@example.test','{"name":"Owner","teacher":true}'),
 ('bf2f73c1-441a-4df3-afc1-7037a8190083','billing-learner@example.test','{"name":"Learner"}'),
 ('bf2f73c1-441a-4df3-afc1-7037a8190084','billing-outside@example.test','{"name":"Other teacher","teacher":true}');
update sls.profiles set role='admin' where email='billing-admin@example.test';
update sls.profiles set trial_until=now()-interval '1 hour' where email='billing-learner@example.test';
create temporary table billing_test(name text primary key,value jsonb);
grant select,insert on billing_test to authenticated;
set local role authenticated;
do $$
declare
  teacher text := 'bf2f73c1-441a-4df3-afc1-7037a8190082';
  learner text := 'bf2f73c1-441a-4df3-afc1-7037a8190083';
  module jsonb;
  slip jsonb;
begin
  assert not has_function_privilege('authenticated','public.sls_submit_verified_slip(uuid,uuid)','EXECUTE');
  perform set_config('request.jwt.claim.sub',teacher,true);
  assert public.sls_billing('read')->>'active' = 'true';
  perform public.sls_billing('save_bank','{"holder":"Owner","bank":"Fixture bank","branch":"Main","account":"0000012345"}');
  module := jsonb_build_object('courseId',public.sls_workspace('create','{"enrollmentCode":"FixtureCode-26","title":"Paid module","monthlyFee":1200}')->'course'->>'id');
  perform public.sls_workspace('edit',module || '{"title":"Paid module","monthlyFee":1400}');
  assert public.sls_workspace('course',module)->'course'->>'monthlyFee' = '1400.00';
  perform public.sls_workspace('lessons',module || '{"title":"Private lecture","text":"Private lesson notes"}');
  perform set_config('request.jwt.claim.sub',learner,true);
  begin
    perform public.sls_billing('read',module);
    raise exception 'Unenrolled student received bank details';
  exception when insufficient_privilege then null;
  end;
  perform public.sls_workspace('enroll',module || '{"enrollmentCode":"FixtureCode-26"}');
  assert public.sls_billing('read',module)->'bank'->>'account' = '0000012345';
  assert public.sls_workspace('course',module)->'lessons' = '[]'::jsonb;
  assert public.sls_workspace('courses')->'courses'->0->>'billingLocked' = 'true';
  begin
    perform public.sls_module_services('list',module);
    raise exception 'Expired student received media';
  exception when sqlstate 'PT402' then null;
  end;
  slip := public.sls_billing('reserve',module || '{"mime":"application/pdf","size":150}');
  assert slip->>'amount' = '1400.00';
  insert into billing_test values('module',module),('student-slip',slip);
  perform set_config('request.jwt.claim.sub',teacher,true);
  slip := public.sls_billing('reserve','{"mime":"image/png","size":100}');
  assert slip->>'amount' = '1800.00';
  insert into billing_test values('teacher-slip',slip);
end $$;
reset role;
update sls.profiles set trial_until=now()-interval '1 hour' where email='billing-owner@example.test';
do $$
declare slip jsonb;
begin
  for slip in select value from billing_test where name in ('teacher-slip','student-slip') loop
    assert public.sls_submit_verified_slip((slip->>'id')::uuid,(slip->>'payer')::uuid);
  end loop;
end $$;
set local role authenticated;
do $$
declare
  admin text := 'bf2f73c1-441a-4df3-afc1-7037a8190081';
  teacher text := 'bf2f73c1-441a-4df3-afc1-7037a8190082';
  learner text := 'bf2f73c1-441a-4df3-afc1-7037a8190083';
  peer text := 'bf2f73c1-441a-4df3-afc1-7037a8190084';
  module jsonb := (select value from billing_test where name='module');
  teacher_slip jsonb := jsonb_build_object('slipId',(select value->>'id' from billing_test where name='teacher-slip'));
  student_slip jsonb := jsonb_build_object('slipId',(select value->>'id' from billing_test where name='student-slip'));
  expiry timestamptz;
  notices jsonb;
begin
  perform set_config('request.jwt.claim.sub',teacher,true);
  begin
    perform public.sls_workspace('create','{"enrollmentCode":"FixtureCode-26","title":"Locked teacher"}');
    raise exception 'Expired teacher created a module';
  exception when sqlstate 'PT402' then null;
  end;
  perform set_config('request.jwt.claim.sub',admin,true);
  notices := public.sls_communications('inbox')->'notifications';
  assert notices @> '[{"title":"Teacher payment awaiting review"},{"title":"Course payment awaiting review: Paid module"}]'::jsonb;
  perform public.sls_billing('approve',teacher_slip);
  perform set_config('request.jwt.claim.sub',peer,true);
  assert not (public.sls_workspace('courses')->'courses' @> jsonb_build_array(jsonb_build_object('id',module->>'courseId')));
  begin
    perform public.sls_workspace('course',module);
    raise exception 'Another teacher opened a private module';
  exception when sqlstate 'PT404' then null;
  end;
  assert public.sls_billing('read')->'queue' = '[]'::jsonb;
  assert public.sls_communications('inbox')->'notifications' = '[]'::jsonb;
  begin
    perform public.sls_billing('open',student_slip);
    raise exception 'Another teacher received a private slip';
  exception when sqlstate 'PT404' then null;
  end;
  perform set_config('request.jwt.claim.sub',teacher,true);
  notices := public.sls_communications('inbox')->'notifications';
  assert notices @> '[{"title":"Course payment awaiting review: Paid module"},{"title":"Payment approved","destination":"/teacher/dashboard#payments"}]'::jsonb;
  assert (public.sls_billing('read')->>'until')::timestamptz = now()+interval '720 hours';
  perform public.sls_billing('approve',student_slip);
  begin
    perform public.sls_billing('approve',student_slip);
    raise exception 'Repeated approval extended access';
  exception when sqlstate 'PT409' then null;
  end;
  perform set_config('request.jwt.claim.sub',learner,true);
  notices := public.sls_communications('inbox')->'notifications';
  assert notices @> jsonb_build_array(jsonb_build_object('title','Payment approved','destination','/modules/' || (module->>'courseId') || '#payments'));
  assert not (notices @> '[{"destination":"/teacher/dashboard#payments"}]'::jsonb);
  expiry := (public.sls_billing('read',module)->>'until')::timestamptz;
  assert expiry=now()+interval '720 hours';
  assert public.sls_workspace('course',module)->'lessons'->0->>'text'='Private lesson notes';
  perform set_config('request.jwt.claim.sub',admin,true);
  perform public.sls_billing('revoke',student_slip);
  perform set_config('request.jwt.claim.sub',learner,true);
  assert public.sls_billing('read',module)->>'active'='false';
end $$;
rollback;
