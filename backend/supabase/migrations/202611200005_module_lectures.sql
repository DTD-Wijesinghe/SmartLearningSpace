begin;

alter table sls.courses alter column status set default 'published';
alter table sls.lessons drop constraint lessons_body_check,
  add constraint lessons_body_check check (length(btrim(body)) <= 12000);
alter table sls.lessons add column lecture_number integer;
with numbered as (
  select id,row_number() over(partition by course order by created_at,id)::integer as lecture_number from sls.lessons
)
update sls.lessons l set lecture_number = n.lecture_number from numbered n where n.id = l.id;
alter table sls.lessons alter column lecture_number set not null,
  add unique(course,lecture_number);

create function sls.number_lecture() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform from sls.courses where id = new.course for update;
  select coalesce(max(lecture_number),0)+1 into new.lecture_number from sls.lessons where course = new.course;
  return new;
end $$;
revoke all on function sls.number_lecture() from public;
create trigger number_lecture before insert on sls.lessons
  for each row execute function sls.number_lecture();

create table sls.module_conversations (
  id uuid primary key default gen_random_uuid(),
  course uuid not null references sls.courses(id),
  student uuid not null references sls.profiles(id),
  kind text not null check (kind in ('question','feedback')),
  subject text not null check (length(btrim(subject)) between 1 and 160),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index module_conversations_course on sls.module_conversations(course, created_at desc);
create table sls.module_messages (
  id uuid primary key default gen_random_uuid(),
  conversation uuid not null references sls.module_conversations(id),
  author uuid not null references sls.profiles(id),
  body text not null check (length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index module_messages_conversation on sls.module_messages(conversation, created_at);
alter table sls.module_conversations enable row level security;
alter table sls.module_messages enable row level security;

create function public.sls_module_page(action text, payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me sls.profiles;
  course_row sls.courses;
  conversation sls.module_conversations;
  is_admin boolean;
  is_owner boolean;
  is_student boolean;
  enrolled boolean := false;
  message_text text;
begin
  select * into me from sls.profiles where id = auth.uid() for share;
  if not found or me.pending or me.suspended then
    raise insufficient_privilege using message = 'Account unavailable.';
  end if;
  select * into course_row from sls.courses where id = (payload->>'courseId')::uuid for share;
  if not found then raise sqlstate 'PT404' using message = 'Module not found.'; end if;
  is_admin := me.role = 'admin';
  is_owner := me.role = 'teacher' and course_row.owner = me.id;
  is_student := me.role = 'student' and course_row.status = 'published';
  if not (is_admin or is_owner or is_student) then
    raise sqlstate 'PT404' using message = 'Module not found.';
  end if;
  if is_student then
    enrolled := exists(select from sls.enrollments e where e.course = course_row.id and e.student = me.id);
  end if;

  if action = 'read' then
    return jsonb_build_object(
      'outline', coalesce((
        select jsonb_agg(jsonb_build_object('id',l.id,'title',l.title,'description',l.description) order by l.lecture_number)
        from sls.lessons l where l.course = course_row.id
      ),'[]'::jsonb),
      'assets', case when is_admin then coalesce((
        select jsonb_agg(to_jsonb(a) order by a.created_at,a.id) from sls.module_assets a where a.course = course_row.id
      ),'[]'::jsonb) else '[]'::jsonb end,
      'conversations', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id',t.id,'kind',t.kind,'subject',t.subject,'student',p.name,'closed',t.closed_at is not null,
          'messages',coalesce((
            select jsonb_agg(jsonb_build_object('author',a.name,'role',a.role,'text',m.body) order by m.created_at,m.id)
            from sls.module_messages m join sls.profiles a on a.id = m.author where m.conversation = t.id
          ),'[]'::jsonb)
        ) order by t.created_at desc,t.id)
        from sls.module_conversations t join sls.profiles p on p.id = t.student
        where t.course = course_row.id and (is_admin or is_owner or (enrolled and t.student = me.id))
      ),'[]'::jsonb)
    );
  elsif action = 'review_asset' then
    if not is_admin then raise insufficient_privilege using message = 'Administrator access required.'; end if;
    return (select to_jsonb(a) from sls.module_assets a where a.id = (payload->>'assetId')::uuid
      and a.course = course_row.id and a.ready_at is not null and a.archived_at is null);
  end if;

  if course_row.status <> 'published' and not (is_admin and action = 'message_status') then
    raise sqlstate 'PT409' using message = 'This module is closed to new messages.';
  end if;
  message_text := btrim(payload->>'text');
  if action = 'message_create' then
    if not enrolled then raise insufficient_privilege using message = 'Enroll in this module to contact your teacher.'; end if;
    if payload->>'kind' is null or payload->>'kind' not in ('question','feedback')
      or coalesce(length(btrim(payload->>'subject')),0) not between 1 and 160 then
      raise sqlstate 'PT400' using message = 'Choose a message type and enter a subject.';
    end if;
    if coalesce(length(message_text),0) not between 1 and 2000 then
      raise sqlstate 'PT400' using message = 'Enter a message of up to 2,000 characters.';
    end if;
    insert into sls.module_conversations(course,student,kind,subject)
      values(course_row.id,me.id,payload->>'kind',btrim(payload->>'subject')) returning * into conversation;
  elsif action in ('message_reply','message_status') then
    select * into conversation from sls.module_conversations t where t.id = (payload->>'threadId')::uuid
      and t.course = course_row.id and (is_admin or is_owner or (enrolled and t.student = me.id)) for update;
    if not found then raise sqlstate 'PT404' using message = 'Conversation not found.'; end if;
    if action = 'message_status' then
      if not is_admin then raise insufficient_privilege using message = 'Administrator access required.'; end if;
      if jsonb_typeof(payload->'closed') is distinct from 'boolean' then
        raise sqlstate 'PT400' using message = 'Choose whether to close or reopen the conversation.';
      end if;
      if (payload->>'closed')::boolean <> (conversation.closed_at is not null) then
        update sls.module_conversations set closed_at = case when (payload->>'closed')::boolean then now() end
          where id = conversation.id;
        insert into sls.audit(actor,action,target) values(me.id,
          case when (payload->>'closed')::boolean then 'conversation.closed' else 'conversation.reopened' end,conversation.id);
      end if;
      return jsonb_build_object('ok',true);
    end if;
    if conversation.closed_at is not null then raise sqlstate 'PT409' using message = 'This conversation is closed.'; end if;
    if coalesce(length(message_text),0) not between 1 and 2000 then
      raise sqlstate 'PT400' using message = 'Enter a reply of up to 2,000 characters.';
    end if;
  else
    raise sqlstate 'PT404' using message = 'Unknown module action.';
  end if;
  insert into sls.module_messages(conversation,author,body) values(conversation.id,me.id,message_text);
  return jsonb_build_object('id',conversation.id);
end $$;
revoke all on function public.sls_module_page(text,jsonb) from public, anon, authenticated;
grant execute on function public.sls_module_page(text,jsonb) to authenticated;
commit;
