begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('bf2f73c1-441a-4df3-afc1-7037a8190051','lecture-admin@example.test','{"name":"Admin"}'),
 ('bf2f73c1-441a-4df3-afc1-7037a8190052','lecture-teacher@example.test','{"name":"Teacher","teacher":true}'),
 ('bf2f73c1-441a-4df3-afc1-7037a8190053','lecture-student@example.test','{"name":"Learner"}'),
 ('bf2f73c1-441a-4df3-afc1-7037a8190054','lecture-peer@example.test','{"name":"Peer"}');
update sls.profiles set role = 'admin' where email = 'lecture-admin@example.test';
update sls.profiles set pending = false where email = 'lecture-teacher@example.test';

set local role authenticated;
do $$
declare
  admin text := 'bf2f73c1-441a-4df3-afc1-7037a8190051';
  teacher text := 'bf2f73c1-441a-4df3-afc1-7037a8190052';
  learner text := 'bf2f73c1-441a-4df3-afc1-7037a8190053';
  peer text := 'bf2f73c1-441a-4df3-afc1-7037a8190054';
  module jsonb;
  thread jsonb;
  page jsonb;
  created jsonb;
begin
  perform set_config('request.jwt.claim.sub',teacher,true);
  created := public.sls_workspace('create','{"title":"Lectures QA"}')->'course';
  assert created->>'status' = 'published';
  module := jsonb_build_object('courseId',created->>'id');
  perform public.sls_workspace('lessons',module || '{"title":"Lecture notes","text":"Private content"}');
  perform public.sls_workspace('lessons',module || '{"title":"Files only","text":""}');
  perform set_config('request.jwt.claim.sub',learner,true);
  page := public.sls_module_page('read',module);
  assert jsonb_array_length(page->'outline') = 2;
  assert page->'outline'->0->>'title' = 'Lecture notes';
  assert page->'outline'->1->>'title' = 'Files only';
  assert not ((page->'outline'->0) ? 'text');
  assert jsonb_array_length(public.sls_workspace('course',module)->'lessons') = 0;
  begin
    perform public.sls_module_page('message_create',module || '{"kind":"question","subject":"Help","text":"Can we review this?"}');
    raise exception 'Unenrolled learner sent a message';
  exception when insufficient_privilege then null;
  end;
  perform public.sls_workspace('enroll',module);
  assert jsonb_array_length(public.sls_workspace('course',module)->'lessons') = 2;
  thread := jsonb_build_object('threadId',public.sls_module_page('message_create',
    module || '{"kind":"question","subject":"Help","text":"Can we review this?"}')->>'id');
  perform set_config('request.jwt.claim.sub',peer,true);
  perform public.sls_workspace('enroll',module);
  assert public.sls_module_page('read',module)->'conversations' = '[]'::jsonb;
  begin
    perform public.sls_module_page('message_reply',module || thread || '{"text":"I can see this"}');
    raise exception 'Peer wrote to another student conversation';
  exception when sqlstate 'PT404' then null;
  end;
  perform set_config('request.jwt.claim.sub',teacher,true);
  perform public.sls_module_page('message_reply',module || thread || '{"text":"Yes, at the next class."}');
  perform set_config('request.jwt.claim.sub',admin,true);
  page := public.sls_module_page('read',module);
  assert jsonb_array_length(page->'conversations'->0->'messages') = 2;
  perform public.sls_module_page('message_status',module || thread || '{"closed":true}');
  perform set_config('request.jwt.claim.sub',learner,true);
  begin
    perform public.sls_module_page('message_reply',module || thread || '{"text":"This should fail"}');
    raise exception 'Learner could reply to a closed conversation';
  exception when sqlstate 'PT409' then null;
  end;
  perform set_config('request.jwt.claim.sub',admin,true);
  perform public.sls_module_page('message_status',module || thread || '{"closed":false}');
  perform set_config('request.jwt.claim.sub',learner,true);
  perform public.sls_module_page('message_reply',module || thread || '{"text":"Thank you."}');
  assert jsonb_array_length(public.sls_module_page('read',module)->'conversations'->0->'messages') = 3;
end $$;
rollback;
