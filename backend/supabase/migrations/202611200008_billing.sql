begin;

alter table sls.profiles add column trial_until timestamptz not null default (now() + interval '120 hours'),
  add column paid_until timestamptz, add column billing_revoked boolean not null default false;
alter table sls.enrollments add column paid_until timestamptz,
  add column billing_revoked boolean not null default false;
alter table sls.courses add column monthly_fee numeric(10,2) not null default 0 check (monthly_fee >= 0);

create table sls.teacher_bank_details (
  teacher uuid primary key references sls.profiles(id),
  holder text not null, bank text not null, branch text not null, account text not null
);
create table sls.payment_slips (
  id uuid primary key default gen_random_uuid(),
  payer uuid not null references sls.profiles(id),
  course uuid references sls.courses(id),
  amount numeric(10,2) not null check (amount > 0),
  mime text not null,
  size_bytes integer not null check (size_bytes between 1 and 5242880),
  status text not null default 'uploading' check (status in ('uploading','pending','approved','rejected','revoked','expired')),
  note text not null default '',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewer uuid references sls.profiles(id),
  coverage_until timestamptz
);
create unique index payment_slips_open on sls.payment_slips(payer,course) nulls not distinct
  where status in ('uploading','pending');
create index payment_slips_course ON sls.payment_slips(course,created_at desc);
create table sls.billing_reminder_log (
  payer uuid not null references sls.profiles(id),
  course uuid references sls.courses(id),
  ends_at timestamptz not null,
  unique nulls not distinct (payer,course,ends_at)
);
alter table sls.teacher_bank_details enable row level security;
alter table sls.payment_slips enable row level security;
alter table sls.billing_reminder_log enable row level security;

create or replace function sls.create_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into sls.profiles(id,email,name,role,pending)
    values(new.id,lower(new.email),left(coalesce(nullif(btrim(new.raw_user_meta_data->>'name'),''),'Learner'),160),
      case when new.raw_user_meta_data->>'teacher' = 'true' then 'teacher' else 'student' end,false)
    on conflict(id) do nothing;
  return new;
end $$;

create or replace function sls.profile_notice() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.role <> 'teacher' then return new; end if;
  if tg_op = 'INSERT' then
    insert into sls.notifications(recipient,title,destination)
      select id,'Teacher registered: ' || new.name,'/admin/dashboard#users'
      from sls.profiles where role = 'admin' and not suspended and not pending;
  elsif old.pending and not new.pending then
    perform sls.send_notice(new.id,'Your teacher account was approved.','/teacher/dashboard');
  end if;
  return new;
end $$;

create function sls.member_access(p sls.profiles, module_id uuid) returns timestamptz
language plpgsql stable set search_path = '' as $$
declare e sls.enrollments;
begin
  if p.id is null or p.suspended or p.pending then return '-infinity'; end if;
  if p.role = 'admin' then return 'infinity'; end if;
  if p.role = 'teacher' then
    if p.billing_revoked then return '-infinity'; end if;
    return greatest(p.trial_until,p.paid_until);
  end if;
  select * into e from sls.enrollments where course = module_id and student = p.id;
  if not found or e.billing_revoked then return '-infinity'; end if;
  if exists(select 1 from sls.courses where id = module_id and monthly_fee = 0) then return 'infinity'; end if;
  return greatest(p.trial_until,e.paid_until);
end $$;

create function sls.queue_billing_reminders(p sls.profiles) returns void
language sql set search_path = '' as $$
  with upcoming as (
    select null::uuid course, greatest(p.trial_until,p.paid_until) ends_at
      where p.role = 'teacher' and not p.billing_revoked
    union all
    select e.course,greatest(p.trial_until,e.paid_until)
    from sls.enrollments e join sls.courses c on c.id=e.course
    where p.role='student' and e.student=p.id and not e.billing_revoked and c.status='published' and c.monthly_fee>0
  ), inserted as (
    insert into sls.billing_reminder_log(payer,course,ends_at)
      select p.id,course,ends_at from upcoming where ends_at > now() and ends_at <= now()+interval '72 hours'
      on conflict do nothing returning course
  )
  insert into sls.notifications(recipient,title,destination)
    select p.id,case when i.course is null then 'Your teacher access expires within 3 days'
      else 'Course fee due soon: ' || c.title end,
      case when i.course is null then '/teacher/dashboard#payments' else '/modules/' || i.course || '#payments' end
    from inserted i left join sls.courses c on c.id=i.course;
$$;

create function sls.slip_reviewer(p sls.profiles, slip sls.payment_slips) returns boolean
language sql stable set search_path = '' as $$
  select p.role='admin' or (p.role='teacher' and sls.member_access(p,null)>now()
    and exists(select from sls.courses where id=slip.course and owner=p.id)
    and slip.payer<>p.id);
$$;

create function public.sls_billing(action text, payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me sls.profiles;
  c sls.courses;
  x sls.payment_slips;
  module_id uuid := nullif(payload->>'courseId','')::uuid;
  amount_due numeric(10,2);
  ends timestamptz;
  bank_json jsonb;
  receipt_mime text := payload->>'mime';
  receipt_size integer;
  note_text text := coalesce(btrim(payload->>'note'),'');
  holder_text text := btrim(payload->>'holder');
  bank_text text := btrim(payload->>'bank');
  branch_text text := btrim(payload->>'branch');
  account_text text := btrim(payload->>'account');
begin
  select * into me from sls.profiles where id=auth.uid();
  if not found or me.pending or me.suspended then
    raise insufficient_privilege using message = 'Account unavailable.';
  end if;
  if action = 'read' or action = 'reserve' then
    if module_id is not null then
      select * into c from sls.courses where id=module_id and status='published';
      if not found or me.role <> 'student' or not exists (
        select from sls.enrollments where course=c.id and student=me.id
      ) then raise insufficient_privilege using message = 'Enroll in the module to view payment details.'; end if;
      amount_due := c.monthly_fee;
      if amount_due>0 then
        select to_jsonb(b)-'teacher' into bank_json from sls.teacher_bank_details b where b.teacher=c.owner;
      end if;
    elsif me.role='teacher' then
      amount_due := 1800;
      select to_jsonb(b)-'teacher' into bank_json from sls.teacher_bank_details b where b.teacher=me.id;
    end if;
    ends := sls.member_access(me,module_id);
    if action = 'read' then
      perform sls.queue_billing_reminders(me);
      return jsonb_build_object('role',me.role,'amount',coalesce(amount_due,0),'active',ends>now(),
        'until',case when isfinite(ends) then ends end,'bank',bank_json,'storage',true,
        'history', coalesce((select jsonb_agg(to_jsonb(s)-'payer'-'reviewer' order by s.created_at desc)
          from (select * from sls.payment_slips
            where payer=me.id and course is not distinct from module_id and status<>'expired'
            order by created_at desc limit 15) s),'[]'::jsonb),
        'queue',case when module_id is null and me.role in ('admin','teacher') then coalesce((
          select jsonb_agg(to_jsonb(q) order by (q.status<>'pending'),q.created_at desc)
          from (select s.id,s.course,s.amount,s.status,s.created_at,s.note,s.coverage_until,
                p.name as payer_name,p.email as payer_email,c2.title as course_title
              from sls.payment_slips s join sls.profiles p on p.id=s.payer left join sls.courses c2 on c2.id=s.course
              where sls.slip_reviewer(me,s) and s.status in ('pending','approved','rejected','revoked')
              order by (s.status<>'pending'),s.created_at desc limit 200) q
        ),'[]'::jsonb) else '[]'::jsonb end);
    end if;
    if coalesce(amount_due,0)<=0 or (module_id is not null and bank_json is null) then
      raise sqlstate 'PT409' using message = 'A payment destination is unavailable for this account.';
    end if;
    if receipt_mime is null or receipt_mime not in ('application/pdf','image/png','image/jpeg','image/webp')
      or coalesce(payload->>'size','') !~ '^[0-9]{1,7}$'
      or (payload->>'size')::integer not between 1 and 5242880 then
      raise sqlstate 'PT400' using message = 'Choose a PDF, PNG, JPEG or WebP slip of up to 5 MiB.';
    end if;
    receipt_size := (payload->>'size')::integer;
    perform pg_advisory_xact_lock(379215735);
    select * into x from sls.payment_slips where payer=me.id and course is not distinct from module_id
      and status in ('uploading','pending') for update;
    if found then
      if x.status='pending' then raise sqlstate 'PT409' using message = 'A payment slip is already awaiting review.'; end if;
      if x.created_at > now()-interval '30 minutes' then
        if x.mime=receipt_mime and x.size_bytes=receipt_size then return to_jsonb(x); end if;
        raise sqlstate 'PT409' using message = 'Retry the same slip or wait 30 minutes to replace the upload.';
      end if;
      update sls.payment_slips set status='expired' where id=x.id;
    end if;
    if (select coalesce(sum(size_bytes),0) from sls.payment_slips)+receipt_size>1073741824 then
      raise sqlstate 'PT409' using message = 'The payment slip storage allocation is full.';
    end if;
    insert into sls.payment_slips(payer,course,amount,mime,size_bytes) values(me.id,module_id,amount_due,receipt_mime,receipt_size)
      returning * into x;
    return to_jsonb(x);
  end if;

  if action = 'save_bank' then
    if me.role<>'teacher' then raise insufficient_privilege using message='Teacher access required.'; end if;
    if coalesce(length(holder_text),0) not between 1 and 120 or coalesce(length(bank_text),0) not between 1 and 100
      or coalesce(length(branch_text),0) not between 1 and 100 or coalesce(account_text,'') !~ '^[0-9 -]{5,40}$' then
      raise sqlstate 'PT400' using message='Enter valid bank details and an account number.';
    end if;
    insert into sls.teacher_bank_details values(me.id,holder_text,bank_text,branch_text,account_text)
      on conflict(teacher) do update set holder=excluded.holder,bank=excluded.bank,branch=excluded.branch,account=excluded.account;
    return '{"ok":true}';
  end if;

  if action not in ('inspect','open','approve','reject','revoke') then
    raise sqlstate 'PT404' using message='Unknown payment operation.';
  end if;
  select s.* into x from sls.payment_slips s where s.id=(payload->>'slipId')::uuid
    and case action when 'inspect' then s.payer=me.id and s.status in ('uploading','pending')
      when 'open' then s.status in ('pending','approved','rejected','revoked') and (s.payer=me.id or sls.slip_reviewer(me,s))
      else sls.slip_reviewer(me,s) end for update;
  if not found then raise sqlstate 'PT404' using message='Payment slip not found.'; end if;
  if action in ('inspect','open') then return to_jsonb(x); end if;
  if length(note_text)>500 then raise sqlstate 'PT400' using message='Keep your review note under 501 characters.'; end if;
  if action='revoke' then
    if me.role<>'admin' then raise insufficient_privilege using message='Administrator access required.'; end if;
    if x.status<>'approved' then raise sqlstate 'PT409' using message='Only an approved payment can be revoked.'; end if;
    if x.course is null then
      update sls.profiles set billing_revoked=true,paid_until=null where id=x.payer and paid_until=x.coverage_until;
    else
      update sls.enrollments set billing_revoked=true,paid_until=null
        where course=x.course and student=x.payer and paid_until=x.coverage_until;
    end if;
    if not found then raise sqlstate 'PT409' using message='Only the payment that set the current access period can be revoked.'; end if;
  else
    if x.status<>'pending' then raise sqlstate 'PT409' using message='This slip has already been reviewed.'; end if;
    if action='approve' then
      if x.course is null then
        update sls.profiles set paid_until=greatest(now(),case when not billing_revoked then greatest(paid_until,trial_until) end)+interval '720 hours',
          billing_revoked=false where id=x.payer returning paid_until into ends;
      else
        update sls.enrollments en set paid_until=greatest(now(),case when not en.billing_revoked then greatest(en.paid_until,p.trial_until) end)+interval '720 hours',
          billing_revoked=false from sls.profiles p where en.course=x.course and en.student=x.payer and p.id=en.student returning en.paid_until into ends;
      end if;
      if ends is null then raise sqlstate 'PT409' using message='The payment account or enrollment is unavailable.'; end if;
    end if;
  end if;
  update sls.payment_slips set status=case action when 'approve' then 'approved' when 'reject' then 'rejected' else 'revoked' end,
    note=note_text,reviewer=me.id,reviewed_at=now(),coverage_until=coalesce(ends,coverage_until) where id=x.id;
  insert into sls.audit(actor,action,target) values(me.id,'payment.' || action,x.id);
  perform sls.send_notice(x.payer,case action when 'approve' then 'Payment approved' when 'reject' then 'Payment slip needs attention' else 'Payment access revoked' end,
    case when x.course is null then '/teacher/dashboard#payments' else '/modules/' || x.course || '#payments' end);
  return '{"ok":true}';
end $$;

create function public.sls_submit_verified_slip(slip_id uuid, payer_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare x sls.payment_slips;
begin
  select * into x from sls.payment_slips where id=slip_id and payer=payer_id for update;
  if not found then return false; end if;
  if x.status='pending' then return true; end if;
  if x.status<>'uploading' or x.created_at<=now()-interval '30 minutes' then return false; end if;
  update sls.payment_slips set status='pending' where id=x.id;
  if x.course is null then
    insert into sls.notifications(recipient,title,destination)
      select id,'Teacher payment awaiting review','/admin/dashboard#payments' from sls.profiles where role='admin' and not suspended and not pending;
  else
    insert into sls.notifications(recipient,title,destination)
      select owner,'Course payment awaiting review: ' || title,'/teacher/dashboard#payments' from sls.courses where id=x.course;
  end if;
  return true;
end $$;

revoke all on function public.sls_billing(text,jsonb) from public,anon,authenticated;
grant execute on function public.sls_billing(text,jsonb) to authenticated;
revoke all on function public.sls_submit_verified_slip(uuid,uuid) from public,anon,authenticated;
grant execute on function public.sls_submit_verified_slip(uuid,uuid) to service_role;
revoke all on function sls.member_access(sls.profiles,uuid),sls.queue_billing_reminders(sls.profiles),
  sls.slip_reviewer(sls.profiles,sls.payment_slips) from public,anon,authenticated;

alter function public.sls_workspace(text,jsonb) set schema sls;
alter function sls.sls_workspace(text,jsonb) rename to workspace_before_billing;
alter function public.sls_module_page(text,jsonb) set schema sls;
alter function sls.sls_module_page(text,jsonb) rename to page_before_billing;
alter function public.sls_module_services(text,jsonb) set schema sls;
alter function sls.sls_module_services(text,jsonb) rename to services_before_billing;
alter function public.sls_communications(text,jsonb) set schema sls;
alter function sls.sls_communications(text,jsonb) rename to communications_before_billing;
revoke all on function sls.workspace_before_billing(text,jsonb),sls.page_before_billing(text,jsonb),
  sls.services_before_billing(text,jsonb),sls.communications_before_billing(text,jsonb) from public,anon,authenticated;

create function sls.billing_user() returns sls.profiles
language plpgsql stable set search_path = '' as $$
declare p sls.profiles;
begin
  select * into p from sls.profiles where id=auth.uid();
  if not found or p.pending or p.suspended then
    raise insufficient_privilege using message='Account unavailable.';
  end if;
  return p;
end $$;
revoke all on function sls.billing_user() from public,anon,authenticated;

create function public.sls_workspace(action text,payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p sls.profiles := sls.billing_user();
  module_id uuid := nullif(payload->>'courseId','')::uuid;
  fee numeric(10,2);
  access_until timestamptz;
  response jsonb;
begin
  if p.role='teacher' and action not in ('me','dashboard') and sls.member_access(p,null)<=now() then
    raise sqlstate 'PT402' using message='Renew your teacher access to use this feature.';
  end if;
  if action in ('create','edit') and payload ? 'monthlyFee' and p.role='teacher' then
    if coalesce(payload->>'monthlyFee','') !~ '^[0-9]{1,8}(\.[0-9]{1,2})?$' then
      raise sqlstate 'PT400' using message='Enter a valid monthly fee in LKR.';
    end if;
    fee := (payload->>'monthlyFee')::numeric;
    if fee>0 and not exists(select from sls.teacher_bank_details where teacher=p.id) then
      raise sqlstate 'PT409' using message='Save your bank details in Payments before charging for a module.';
    end if;
  end if;
  if p.role='student' and module_id is not null and action not in ('course','enroll')
    and exists(select from sls.enrollments where course=module_id and student=p.id)
    and sls.member_access(p,module_id)<=now() then
    raise sqlstate 'PT402' using message='Pay your course fee to access this feature.';
  end if;
  response := sls.workspace_before_billing(action,payload);
  if action='courses' then
    return jsonb_build_object('courses',coalesce((
      select jsonb_agg(item || jsonb_build_object('monthlyFee',c.monthly_fee,'billingLocked',
        p.role='student' and coalesce((item->>'enrolled')::boolean,false) and sls.member_access(p,c.id)<=now()) order by position)
      from jsonb_array_elements(response->'courses') with ordinality as rows(item,position)
      join sls.courses c on c.id=(item->>'id')::uuid
    ),'[]'::jsonb));
  end if;
  if action in ('create','edit') and fee is not null then
    update sls.courses set monthly_fee=fee where id=(response->'course'->>'id')::uuid and owner=p.id;
    return jsonb_set(response,'{course,monthlyFee}',to_jsonb(fee),true);
  end if;
  if action='course' then
    select monthly_fee into fee from sls.courses where id=module_id;
    access_until := sls.member_access(p,module_id);
    response := jsonb_set(response,'{course,monthlyFee}',to_jsonb(fee),true);
    response := jsonb_set(response,'{course,billingLocked}',to_jsonb(p.role='student' and access_until<=now()
      and coalesce((response->'course'->>'enrolled')::boolean,false)),true);
    if p.role='student' and access_until<=now() then
      return jsonb_set(response || '{"lessons":[],"completed":[],"exams":[],"history":[],"learnerProgress":[]}', '{course,progress}','0');
    end if;
  end if;
  return response;
end $$;

create function public.sls_module_page(action text,payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p sls.profiles := sls.billing_user();
  module_id uuid := (payload->>'courseId')::uuid;
  response jsonb;
begin
  if p.role='teacher' and sls.member_access(p,null)<=now() then
    raise sqlstate 'PT402' using message='Renew your teacher access to use this feature.';
  end if;
  if p.role='student' and action<>'read' and sls.member_access(p,module_id)<=now()
    and exists(select from sls.enrollments where course=module_id and student=p.id) then
    raise sqlstate 'PT402' using message='Pay your course fee to access this feature.';
  end if;
  response := sls.page_before_billing(action,payload);
  if p.role='student' and sls.member_access(p,module_id)<=now() then
    return response || '{"conversations":[],"assets":[]}';
  end if;
  return response;
end $$;

create function public.sls_module_services(action text,payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p sls.profiles := sls.billing_user();
  module_id uuid := (payload->>'courseId')::uuid;
  ends timestamptz := sls.member_access(p,module_id);
  response jsonb;
begin
  if action='end_live_access' then
    if p.role<>'teacher' then raise insufficient_privilege using message='Only the module owner can end this class.'; end if;
    return sls.services_before_billing('join_live',payload);
  end if;
  if ends<=now() and (p.role='teacher' or exists(select from sls.enrollments where course=module_id and student=p.id))
    and not (p.role='teacher' and action='end_live') then
    raise sqlstate 'PT402' using message='Renew your access to use this feature.';
  end if;
  response := sls.services_before_billing(action,payload);
  if action in ('get_asset','join_live') and isfinite(ends) then
    return response || jsonb_build_object('access_until',ends);
  end if;
  return response;
end $$;

create function public.sls_communications(action text,payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p sls.profiles := sls.billing_user();
begin
  if action in ('list','inbox') then perform sls.queue_billing_reminders(p); end if;
  return sls.communications_before_billing(action,payload);
end $$;
revoke all on function public.sls_workspace(text,jsonb),public.sls_module_page(text,jsonb),
  public.sls_module_services(text,jsonb),public.sls_communications(text,jsonb) from public,anon,authenticated;
grant execute on function public.sls_workspace(text,jsonb),public.sls_module_page(text,jsonb),
  public.sls_module_services(text,jsonb),public.sls_communications(text,jsonb) to authenticated;

commit;
