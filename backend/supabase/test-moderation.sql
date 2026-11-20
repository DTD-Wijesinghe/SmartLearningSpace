begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('bf2f73c1-441a-4df3-afc1-7037a8190041','moderation-admin@example.test','{"name":"Admin"}'),
 ('bf2f73c1-441a-4df3-afc1-7037a8190042','moderation-teacher@example.test','{"teacher":true,"name":"Teacher"}'),
 ('bf2f73c1-441a-4df3-afc1-7037a8190043','moderation-student@example.test','{"name":"Student"}');
update sls.profiles set role = 'admin' where email = 'moderation-admin@example.test';
update sls.profiles set pending = false where email = 'moderation-teacher@example.test';
insert into sls.courses(id,owner,title,status) values
 ('bf2f73c1-441a-4df3-afc1-7037a8190044','bf2f73c1-441a-4df3-afc1-7037a8190042','Moderation test','published'),
 ('bf2f73c1-441a-4df3-afc1-7037a8190045','bf2f73c1-441a-4df3-afc1-7037a8190042','Draft test','draft');
insert into sls.lessons(id,course,title,body) values
 ('bf2f73c1-441a-4df3-afc1-7037a8190046','bf2f73c1-441a-4df3-afc1-7037a8190044','Lesson','Notes');
insert into sls.module_assets(id,course,lesson,name,mime,size_bytes,ready_at) values
 ('bf2f73c1-441a-4df3-afc1-7037a8190047','bf2f73c1-441a-4df3-afc1-7037a8190044',
  'bf2f73c1-441a-4df3-afc1-7037a8190046','Notes.pdf','application/pdf',2048,now());
insert into sls.enrollments values
 ('bf2f73c1-441a-4df3-afc1-7037a8190044','bf2f73c1-441a-4df3-afc1-7037a8190043');

set local role authenticated;
do $$
declare
  admin_id text := 'bf2f73c1-441a-4df3-afc1-7037a8190041';
  learner_id text := 'bf2f73c1-441a-4df3-afc1-7037a8190043';
  module jsonb := '{"courseId":"bf2f73c1-441a-4df3-afc1-7037a8190044"}';
  draft jsonb := '{"courseId":"bf2f73c1-441a-4df3-afc1-7037a8190045"}';
  material jsonb := '{"assetId":"bf2f73c1-441a-4df3-afc1-7037a8190047"}';
begin
  perform set_config('request.jwt.claim.sub','bf2f73c1-441a-4df3-afc1-7037a8190042',true);
  begin
    perform public.sls_module_services('material_moderation', module || material || '{"archived":true}');
    raise exception 'Teacher was able to moderate a file';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claim.sub',admin_id,true);
  begin
    perform public.sls_module_services('material_moderation', draft || material || '{"archived":true}');
    raise exception 'Wrong module accepted a material ID';
  exception when sqlstate 'PT404' then null;
  end;
  perform public.sls_module_services('archive',draft);
  perform public.sls_module_services('archive',draft);
  perform public.sls_module_services('restore',draft);
  assert public.sls_workspace('course',draft)->'course'->>'status' = 'draft';
  perform public.sls_module_services('archive',module);
  perform public.sls_module_services('material_moderation',module || material || '{"archived":true}');
  assert public.sls_module_services('moderation',module)->'assets'->0->>'archived' = 'true';

  perform set_config('request.jwt.claim.sub',learner_id,true);
  begin
    perform public.sls_workspace('course',module);
    raise exception 'Learner was able to open archived module';
  exception when sqlstate 'PT404' then null;
  end;
  perform set_config('request.jwt.claim.sub',admin_id,true);
  perform public.sls_module_services('restore',module);
  perform set_config('request.jwt.claim.sub',learner_id,true);
  assert jsonb_array_length(public.sls_module_services('list',module)->'assets') = 0;
  begin
    perform public.sls_module_services('get_asset',module || material);
    raise exception 'Learner was able to access removed material';
  exception when sqlstate 'PT404' then null;
  end;
  perform set_config('request.jwt.claim.sub',admin_id,true);
  perform public.sls_module_services('material_moderation',module || material || '{"archived":false}');
  perform set_config('request.jwt.claim.sub',learner_id,true);
  assert public.sls_module_services('get_asset',module || material)->>'name' = 'Notes.pdf';
end $$;
rollback;
