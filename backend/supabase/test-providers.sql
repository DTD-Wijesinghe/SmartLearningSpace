begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('bf2f73c1-441a-4df3-afc1-7037a8190011','provider-teacher@example.test','{"teacher":true,"name":"Owner"}'),
 ('bf2f73c1-441a-4df3-afc1-7037a8190012','provider-student@example.test','{"name":"Learner"}');
update sls.profiles set pending = false where email = 'provider-teacher@example.test';
insert into sls.courses(id,owner,title,status) values
 ('bf2f73c1-441a-4df3-afc1-7037a8190013','bf2f73c1-441a-4df3-afc1-7037a8190011','Services QA','published'),
 ('bf2f73c1-441a-4df3-afc1-7037a8190015','bf2f73c1-441a-4df3-afc1-7037a8190011','Second module','published');
insert into sls.lessons(id,course,title,body) values
 ('bf2f73c1-441a-4df3-afc1-7037a8190014','bf2f73c1-441a-4df3-afc1-7037a8190013','Lesson','Lesson body');
create temporary table provider_test_ids(id uuid);
grant select, insert on provider_test_ids to authenticated;
set local role authenticated;
do $$
declare
  teacher text := 'bf2f73c1-441a-4df3-afc1-7037a8190011';
  student text := 'bf2f73c1-441a-4df3-afc1-7037a8190012';
  module jsonb := '{"courseId":"bf2f73c1-441a-4df3-afc1-7037a8190013"}';
  second_module jsonb := '{"courseId":"bf2f73c1-441a-4df3-afc1-7037a8190015","title":"Second class"}';
  media jsonb;
  live jsonb;
begin
  assert not has_function_privilege(current_user,'public.sls_confirm_material(uuid,text,bigint)','EXECUTE');
  perform set_config('request.jwt.claim.sub',teacher,true);
  media := public.sls_module_services('reserve_asset', module || '{"lessonId":"bf2f73c1-441a-4df3-afc1-7037a8190014","name":"QA.pdf","mime":"application/pdf","size":2048}');
  perform public.sls_workspace('asset_edit',module || jsonb_build_object('assetId',media->>'id','name','Lecture guide.pdf'));
  assert public.sls_module_services('list',module)->'assets'->0->>'name' = 'Lecture guide.pdf';
  insert into provider_test_ids values((media->>'id')::uuid);
  live := public.sls_module_services('start_live',module || '{"title":"Private class"}');
  assert public.sls_module_services('join_live',module)->>'host' = 'true';
  assert public.sls_module_services('start_live',module || '{"title":"Private class"}')->>'id' = live->>'id';
  begin
    perform public.sls_module_services('start_live',second_module);
    raise exception 'Teacher opened two live classes';
  exception when unique_violation then null;
  end;
  perform set_config('request.jwt.claim.sub',student,true);
  begin
    perform public.sls_module_services('join_live',module);
    raise exception 'Unenrolled student received a room grant';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.sls_workspace('enroll',module || '{"enrollmentCode":"FixtureCode-26"}');
    raise exception 'Student enrolled in a legacy module without a code set';
  exception when sqlstate 'PT409' then null;
  end;
  perform set_config('request.jwt.claim.sub',teacher,true);
  assert public.sls_workspace('course',module)->'course'->>'enrollmentCodeSet' = 'false';
  perform public.sls_workspace('edit',module || '{"title":"Services QA","enrollmentCode":"FixtureCode-26"}');
  perform set_config('request.jwt.claim.sub',student,true);
  perform public.sls_workspace('enroll',module || '{"enrollmentCode":"FixtureCode-26"}');
  assert public.sls_module_services('join_live',module)->>'host' = 'false';
  assert public.sls_module_services('list',module)->'assets' = '[]';
  begin
    perform public.sls_module_services('verify_asset',module || jsonb_build_object('assetId',media->>'id'));
    raise exception 'Student was able to verify a material';
  exception when insufficient_privilege then null;
  end;
  for n in 1..12 loop perform public.sls_module_services('ai_quota'); end loop;
  begin
    perform public.sls_module_services('ai_quota');
    raise exception 'AI quota did not stop excess usage';
  exception when sqlstate 'PT429' then null;
  end;
  perform set_config('request.jwt.claim.sub',teacher,true);
  perform public.sls_module_services('end_live',module || jsonb_build_object('session',live->>'id'));
  begin
    perform public.sls_module_services('join_live',module);
    raise exception 'Closed room returned a grant';
  exception when sqlstate 'PT404' then null;
  end;
  assert public.sls_module_services('start_live',second_module)->>'course' = second_module->>'courseId';
end $$;
reset role;
do $$
declare asset uuid := (select id from provider_test_ids);
begin
  assert not public.sls_confirm_material(asset,'application/pdf',1);
  assert public.sls_confirm_material(asset,'application/pdf',2048);
end $$;
set local role authenticated;
do $$
begin
  perform set_config('request.jwt.claim.sub','bf2f73c1-441a-4df3-afc1-7037a8190012',true);
  assert jsonb_array_length(public.sls_module_services('list','{"courseId":"bf2f73c1-441a-4df3-afc1-7037a8190013"}')->'assets') = 1;
end $$;
rollback;
