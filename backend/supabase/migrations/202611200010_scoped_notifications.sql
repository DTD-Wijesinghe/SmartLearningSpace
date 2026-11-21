begin;

alter table sls.notifications add column message text not null default '' check (length(message) <= 1000),
  add column recipient_role text check (recipient_role in ('admin','teacher','student'));
update sls.notifications n set recipient_role =
  case when split_part(n.destination,'/',2) in ('admin','teacher','student')
    then split_part(n.destination,'/',2) else p.role end
from sls.profiles p where p.id = n.recipient;
alter table sls.notifications alter column recipient_role set not null;

create function sls.set_notice_role() returns trigger
language plpgsql set search_path = '' as $$
begin
  select role into new.recipient_role from sls.profiles where id = new.recipient;
  return new;
end $$;
create trigger notification_recipient_role before insert on sls.notifications
  for each row execute function sls.set_notice_role();

create or replace function public.sls_communications(action text,payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me sls.profiles := sls.billing_user();
  audience text := payload->>'audience';
  title_text text := btrim(payload->>'title');
  message_text text := btrim(payload->>'message');
  delivered integer;
  response jsonb;
begin
  if action = 'announce' then
    if me.role <> 'admin' then raise insufficient_privilege using message = 'Administrator access required.'; end if;
    if audience is null or audience not in ('teacher','student','both')
      or coalesce(length(title_text),0) not between 1 and 120
      or coalesce(length(message_text),0) not between 1 and 1000 then
      raise sqlstate 'PT422' using message = 'Choose an audience and enter a title and message.';
    end if;
    insert into sls.notifications(recipient,title,destination,message)
      select p.id,title_text,'/' || p.role || '/dashboard#notifications',message_text
      from sls.profiles p where p.role in ('teacher','student') and not p.suspended and not p.pending
        and (audience = 'both' or p.role = audience);
    get diagnostics delivered = row_count;
    return jsonb_build_object('delivered',delivered);
  end if;
  if action in ('list','inbox') then
    perform sls.queue_billing_reminders(me);
    response := case when action = 'list' then sls.communications_before_billing(action,payload) else '{}'::jsonb end;
    return response || jsonb_build_object(
      'unread',(select count(*) from sls.notifications where recipient = me.id and recipient_role = me.role and read_at is null),
      'notifications',coalesce((
        select jsonb_agg(jsonb_build_object('id',n.id,'title',n.title,'message',n.message,'destination',n.destination,
          'created_at',n.created_at,'read_at',n.read_at) order by n.read_at is null desc,n.created_at desc,n.id)
        from (select * from sls.notifications where recipient = me.id and recipient_role = me.role
          order by read_at is null desc,created_at desc,id limit 50) n
      ),'[]'::jsonb),
      'feedback',coalesce(response->'feedback','[]'::jsonb));
  end if;
  if action in ('read','read_all') then
    update sls.notifications set read_at = coalesce(read_at,now())
      where recipient = me.id and recipient_role = me.role
        and case when action = 'read' then id = (payload->>'notificationId')::uuid else read_at is null end;
    if action = 'read' and not found then raise sqlstate 'PT404' using message = 'Notification not found.'; end if;
    return '{"ok":true}';
  end if;
  return sls.communications_before_billing(action,payload);
end $$;

create function sls.admin_payment_notice() returns trigger
language plpgsql security definer set search_path = '' as $$
declare course_title text;
begin
  select title into course_title from sls.courses where id = new.course;
  insert into sls.notifications(recipient,title,destination)
    select p.id,case
      when new.status = 'pending' then 'Course payment awaiting review: ' || course_title
      else (case when new.course is null then 'Teacher subscription payment ' else 'Course payment ' end)
        || new.status || coalesce(': ' || course_title,'') end,
      '/admin/dashboard#payments'
    from sls.profiles p where p.role = 'admin' and not p.suspended and not p.pending;
  return new;
end $$;
create trigger admin_payment_notice after update of status on sls.payment_slips for each row
  when (old.status is distinct from new.status and
    ((new.status = 'pending' and new.course is not null) or new.status in ('approved','rejected','revoked')))
  execute function sls.admin_payment_notice();

create function sls.admin_module_notice() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into sls.notifications(recipient,title,destination)
    select p.id,'Module created: ' || new.title,'/modules/' || new.id
    from sls.profiles p where p.role = 'admin' and not p.suspended and not p.pending;
  return new;
end $$;
create trigger admin_module_notice after insert on sls.courses for each row execute function sls.admin_module_notice();

revoke all on function sls.set_notice_role(),sls.admin_payment_notice(),sls.admin_module_notice() from public,anon,authenticated;

commit;
