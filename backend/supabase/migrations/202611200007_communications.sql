begin;

create table sls.platform_feedback (
  id uuid primary key default gen_random_uuid(),
  sender uuid not null references sls.profiles(id),
  topic text not null check (topic in ('issue', 'suggestion', 'general')),
  subject text not null check (length(subject) between 1 and 120),
  message text not null check (length(message) between 1 and 2000),
  status text not null default 'new' check (status in ('new', 'reviewing', 'resolved')),
  response text not null default '' check (length(response) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index feedback_sender on sls.platform_feedback(sender);
alter table sls.platform_feedback enable row level security;

create table sls.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient uuid not null references sls.profiles(id) on delete cascade,
  title text not null,
  destination text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_recipient_recent on sls.notifications(recipient, created_at desc, id);
create index notifications_recipient_unread on sls.notifications(recipient) where read_at is null;
alter table sls.notifications enable row level security;

create function sls.send_notice(target uuid, title_text text, link text) returns void
language sql set search_path = '' as $$
  insert into sls.notifications(recipient,title,destination) values(target,title_text,link);
$$;
revoke all on function sls.send_notice(uuid,text,text) from public, anon, authenticated;

create function public.sls_communications(action text, payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me sls.profiles;
  item sls.platform_feedback;
  entry_id uuid;
  next_status text := payload->>'status';
  answer text := coalesce(btrim(payload->>'response'),'');
begin
  select * into me from sls.profiles where id = auth.uid() for share;
  if not found or me.suspended or me.pending then
    raise insufficient_privilege using message = 'Account unavailable.';
  end if;
  if action in ('list','inbox') then
    return jsonb_build_object(
      'unread',(select count(*) from sls.notifications where recipient = me.id and read_at is null),
      'notifications',coalesce((
        select jsonb_agg(to_jsonb(n) - 'recipient' order by n.created_at desc,n.id)
        from (select * from sls.notifications where recipient = me.id
          order by read_at is null desc,created_at desc,id limit 50) n
      ),'[]'::jsonb),
      'feedback',case when action = 'list' then coalesce((
        select jsonb_agg((to_jsonb(f) - 'sender') || jsonb_build_object('senderName',p.name,'senderRole',p.role)
          order by (f.status = 'resolved'),f.updated_at desc,f.id)
        from sls.platform_feedback f join sls.profiles p on p.id = f.sender
        where me.role = 'admin' or f.sender = me.id
      ),'[]'::jsonb) else '[]'::jsonb end);
  elsif action = 'read_all' then
    update sls.notifications set read_at = now() where recipient = me.id and read_at is null;
  elsif action = 'read' then
    update sls.notifications set read_at = coalesce(read_at,now())
      where recipient = me.id and id = (payload->>'notificationId')::uuid;
    if not found then raise sqlstate 'PT404' using message = 'Notification not found.'; end if;
  elsif action = 'submit' then
    if me.role not in ('teacher','student') then raise insufficient_privilege using message = 'Teacher or student access required.'; end if;
    if payload->>'topic' is null or payload->>'topic' not in ('issue','suggestion','general')
      or coalesce(length(btrim(payload->>'subject')),0) not between 1 and 120
      or coalesce(length(btrim(payload->>'message')),0) not between 1 and 2000 then
      raise sqlstate 'PT400' using message = 'Choose a topic and enter a subject and message.';
    end if;
    insert into sls.platform_feedback(sender,topic,subject,message)
      values(me.id,payload->>'topic',btrim(payload->>'subject'),btrim(payload->>'message')) returning id into entry_id;
    insert into sls.notifications(recipient,title,destination)
      select id,'New platform feedback: ' || btrim(payload->>'subject'),'/admin/dashboard#feedback-' || entry_id
      from sls.profiles where role = 'admin' and not suspended and not pending;
    return jsonb_build_object('id',entry_id);
  elsif action = 'review' then
    if me.role <> 'admin' then raise insufficient_privilege using message = 'Administrator access required.'; end if;
    if next_status is null or next_status not in ('new','reviewing','resolved') or length(answer) > 2000 then
      raise sqlstate 'PT400' using message = 'Choose a status and keep your response under 2,001 characters.';
    end if;
    select * into item from sls.platform_feedback where id = (payload->>'feedbackId')::uuid for update;
    if not found then raise sqlstate 'PT404' using message = 'Feedback not found.'; end if;
    if item.status is distinct from next_status or item.response is distinct from answer then
      update sls.platform_feedback set status = next_status,response = answer,updated_at = now() where id = item.id;
      insert into sls.audit(actor,action,target) values(me.id,'feedback.reviewed',item.id);
      insert into sls.notifications(recipient,title,destination)
        select id,'Feedback updated: ' || item.subject, '/' || role || '/dashboard#feedback-' || item.id
        from sls.profiles where id = item.sender;
    end if;
    return jsonb_build_object('id',item.id);
  else
    raise sqlstate 'PT404' using message = 'Unknown communications action.';
  end if;
  return jsonb_build_object('ok',true);
end $$;
revoke all on function public.sls_communications(text,jsonb) from public, anon, authenticated;
grant execute on function public.sls_communications(text,jsonb) to authenticated;

create function sls.profile_notice() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.role <> 'teacher' then return new; end if;
  if tg_op = 'INSERT' then
    if new.pending then
      insert into sls.notifications(recipient,title,destination)
        select id,'Teacher approval requested: ' || new.name,'/admin/dashboard#users'
        from sls.profiles where role = 'admin' and not suspended and not pending;
    end if;
  elsif old.pending and not new.pending then
    perform sls.send_notice(new.id,'Your teacher account was approved.','/teacher/dashboard');
  end if;
  return new;
end $$;

create function sls.module_message_notice() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  item record;
  link text;
begin
  select t.id,t.course,t.student,t.subject,c.owner into item
    from sls.module_conversations t join sls.courses c on c.id = t.course where t.id = new.conversation;
  link := '/modules/' || item.course || '#thread-' || item.id;
  if new.author = item.student then
    perform sls.send_notice(item.owner,'Student message: ' || item.subject,link);
  else
    perform sls.send_notice(item.student,'Reply in your module: ' || item.subject,link);
  end if;
  return new;
end $$;

create function sls.module_live_notice() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into sls.notifications(recipient,title,destination)
    select e.student,'Live class started: ' || new.title,'/modules/' || new.course || '?live=' || new.id
    from sls.enrollments e join sls.profiles p on p.id = e.student
    where e.course = new.course and not p.suspended and not p.pending;
  return new;
end $$;

create function sls.exam_result_notice() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into sls.notifications(recipient,title,destination)
    select new.student,'Exam result available: ' || e.title,'/modules/' || e.course
    from sls.exams e where e.id = new.exam;
  return new;
end $$;

revoke all on function sls.profile_notice(),sls.module_message_notice(),sls.module_live_notice(),sls.exam_result_notice() from public, anon, authenticated;
create trigger profile_notice after insert or update of pending on sls.profiles
  for each row execute function sls.profile_notice();
create trigger module_message_notice after insert on sls.module_messages for each row execute function sls.module_message_notice();
create trigger module_live_notice after insert on sls.live_sessions for each row execute function sls.module_live_notice();
create trigger exam_result_notice after update of released_at on sls.exam_submissions
  for each row when (old.released_at is null and new.released_at is not null) execute function sls.exam_result_notice();
commit;
