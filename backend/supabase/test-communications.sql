begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('bf2f73c1-441a-4df3-afc1-7037a8190071','notices-admin@example.test','{"name":"Admin"}');
update sls.profiles set role = 'admin' where email = 'notices-admin@example.test';
insert into auth.users(id,email,raw_user_meta_data) values
 ('bf2f73c1-441a-4df3-afc1-7037a8190072','notices-teacher@example.test','{"name":"Teacher","teacher":true}'),
 ('bf2f73c1-441a-4df3-afc1-7037a8190073','notices-student@example.test','{"name":"Student"}'),
 ('bf2f73c1-441a-4df3-afc1-7037a8190074','notices-peer@example.test','{"name":"Peer"}');
update sls.profiles set pending = true where email = 'notices-teacher@example.test';
update sls.profiles set pending = false where email = 'notices-teacher@example.test';

set local role authenticated;
do $$
declare
  admin text := 'bf2f73c1-441a-4df3-afc1-7037a8190071';
  teacher text := 'bf2f73c1-441a-4df3-afc1-7037a8190072';
  learner text := 'bf2f73c1-441a-4df3-afc1-7037a8190073';
  peer text := 'bf2f73c1-441a-4df3-afc1-7037a8190074';
  module jsonb;
  review jsonb;
  item jsonb;
  notice jsonb;
begin
  assert not has_function_privilege('anon','public.sls_communications(text,jsonb)','EXECUTE');
  perform set_config('request.jwt.claim.sub',teacher,true);
  assert (public.sls_communications('list')->'notifications'->0->>'title') = 'Your teacher account was approved.';
  module := jsonb_build_object('courseId',public.sls_workspace('create','{"enrollmentCode":"FixtureCode-26","title":"Notices QA"}')->'course'->>'id');
  perform set_config('request.jwt.claim.sub',learner,true);
  perform public.sls_workspace('enroll',module || '{"enrollmentCode":"FixtureCode-26"}');
  review := jsonb_build_object('feedbackId', public.sls_communications('submit',
    '{"topic":"issue","subject":"Playback","message":"Video paused unexpectedly."}')->>'id');
  perform set_config('request.jwt.claim.sub',admin,true);
  item := public.sls_communications('list');
  assert item->'feedback'->0->>'subject' = 'Playback';
  assert (item->>'unread')::integer = 2;
  select jsonb_build_object('notificationId',n->>'id') into notice
    from jsonb_array_elements(item->'notifications') n where n->>'title' = 'New platform feedback: Playback';
  assert notice is not null;
  perform set_config('request.jwt.claim.sub',peer,true);
  assert public.sls_communications('list')->'feedback' = '[]'::jsonb;
  assert public.sls_communications('list')->'notifications' = '[]'::jsonb;
  begin
    perform public.sls_communications('read',notice);
    raise exception 'Peer marked someone else''s notification read';
  exception when sqlstate 'PT404' then null;
  end;
  begin
    perform public.sls_communications('review',review || '{"status":"resolved"}');
    raise exception 'Student updated platform feedback';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claim.sub',admin,true);
  perform public.sls_communications('review',review || '{"status":"resolved","response":"Try again."}');
  perform public.sls_communications('review',review || '{"status":"resolved","response":"Try again."}');
  perform set_config('request.jwt.claim.sub',teacher,true);
  perform public.sls_module_services('start_live',module || '{"title":"Private class"}');
  assert (public.sls_communications('inbox')->>'unread')::integer = 1;
  perform set_config('request.jwt.claim.sub',learner,true);
  item := public.sls_communications('list');
  assert (item->>'unread')::integer = 2;
  assert item->'feedback'->0->>'response' = 'Try again.';
  assert item->'notifications' @> '[{"title":"Live class started: Private class"}]'::jsonb;
  perform public.sls_communications('read_all');
  assert (public.sls_communications('inbox')->>'unread')::integer = 0;
  perform set_config('request.jwt.claim.sub',peer,true);
  assert (public.sls_communications('inbox')->>'unread')::integer = 0;
end $$;
rollback;
