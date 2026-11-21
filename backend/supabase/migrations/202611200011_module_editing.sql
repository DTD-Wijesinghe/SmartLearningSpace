begin;

alter table sls.exams add column version uuid;

create or replace function sls.record_course_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.title,new.subject,new.description,new.status,new.monthly_fee)
    is not distinct from (old.title,old.subject,old.description,old.status,old.monthly_fee) then
    return new;
  end if;
  insert into sls.course_revisions(course,actor,snapshot) values(new.id,auth.uid(),jsonb_build_object(
    'title',new.title,'subject',new.subject,'description',new.description,'status',new.status,'monthlyFee',new.monthly_fee));
  return new;
end $$;

alter function public.sls_workspace(text,jsonb) set schema sls;
alter function sls.sls_workspace(text,jsonb) rename to workspace_before_module_editing;
revoke all on function sls.workspace_before_module_editing(text,jsonb) from public,anon,authenticated;

create function public.sls_workspace(action text, payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me sls.profiles := sls.billing_user();
  module_id uuid := nullif(payload->>'courseId','')::uuid;
  response jsonb;
  title_text text := btrim(payload->>'title');
  exam sls.exams;
  new_questions jsonb := payload->'questions';
  question jsonb;
begin
  if action in ('lesson_edit','asset_edit','exam_edit') then
    if me.role <> 'teacher' then raise insufficient_privilege using message = 'Only the module teacher can edit this content.'; end if;
    if sls.member_access(me,null) <= now() then
      raise sqlstate 'PT402' using message = 'Renew your teacher access to use this feature.';
    end if;
    perform from sls.profiles where id = me.id for share;
    perform from sls.courses where id = module_id and owner = me.id and status <> 'suspended' for update;
    if not found then raise sqlstate 'PT404' using message = 'Editable module not found.'; end if;
    if action = 'lesson_edit' then
      if coalesce(length(title_text),0) not between 1 and 160 or length(coalesce(payload->>'description','')) > 1000
        or length(coalesce(payload->>'text','')) > 12000 then
        raise sqlstate 'PT422' using message = 'Check the lecture title, description, and notes.';
      end if;
      update sls.lessons set title = title_text, description = coalesce(btrim(payload->>'description'),''),
        body = coalesce(btrim(payload->>'text'),'') where course = module_id and id = (payload->>'lessonId')::uuid;
      if not found then raise sqlstate 'PT404' using message = 'Lecture not found in this module.'; end if;
    elsif action = 'asset_edit' then
      if coalesce(length(btrim(payload->>'name')),0) not between 1 and 160 then
        raise sqlstate 'PT422' using message = 'Enter a material name of up to 160 characters.';
      end if;
      update sls.module_assets set name = btrim(payload->>'name')
        where course = module_id and id = (payload->>'assetId')::uuid and archived_at is null;
      if not found then raise sqlstate 'PT404' using message = 'Material not found in this module.'; end if;
    else
      select * into exam from sls.exams where course = module_id and id = (payload->>'examId')::uuid;
      if not found then raise sqlstate 'PT404' using message = 'Exam not found in this module.'; end if;
      if coalesce(length(title_text),0) not between 1 and 160 then
        raise sqlstate 'PT422' using message = 'Enter an exam title of up to 160 characters.';
      end if;
      if new_questions is not null and new_questions is distinct from exam.questions then
        if exists(select from sls.exam_submissions where exam_submissions.exam = exam.id) then
          raise sqlstate 'PT409' using message = 'Questions and answer keys are locked once a student has submitted. You can still rename the exam.';
        end if;
        if (case when jsonb_typeof(new_questions) = 'array'
          then jsonb_array_length(new_questions) not between 1 and 25 else true end) then
          raise sqlstate 'PT422' using message = 'Enter 1 to 25 exam questions.';
        end if;
        for question in select value from jsonb_array_elements(new_questions) loop
          if jsonb_typeof(question->'options') is distinct from 'array'
            or coalesce(question->>'correct','') !~ '^[0-5]$'
            or jsonb_typeof(question->'correct') is distinct from 'number'
            or jsonb_typeof(question->'prompt') is distinct from 'string'
            or length(btrim(question->>'prompt')) not between 1 and 500 then
            raise sqlstate 'PT422' using message = 'Enter a question, choices, and a correct choice.';
          end if;
          if jsonb_array_length(question->'options') not between 2 and 6
            or (question->>'correct')::integer >= jsonb_array_length(question->'options')
            or exists(select from jsonb_array_elements(question->'options') v
              where jsonb_typeof(v) <> 'string' or length(btrim(v#>>'{}')) not between 1 and 200)
            or exists(select from jsonb_object_keys(question) k where k not in ('prompt','options','correct')) then
            raise sqlstate 'PT422' using message = 'Check the exam answer choices.';
          end if;
        end loop;
        update sls.exams set title = title_text, questions = new_questions, version = gen_random_uuid() where id = exam.id;
      else
        update sls.exams set title = title_text where id = exam.id;
      end if;
    end if;
    insert into sls.audit(actor,action,target) values(me.id,action,module_id);
    return '{"ok":true}';
  end if;

  if action = 'exam_submit' and me.role = 'student' then
    -- Serialize submission with the teacher editing questions on the same module.
    perform from sls.profiles where id = me.id for share;
    perform from sls.courses where id = module_id for update;
    if exists(select from sls.enrollments en join sls.courses c on c.id = en.course
      where en.course = module_id and en.student = me.id and c.status = 'published')
      and sls.member_access(me,module_id)>now() then
      select * into exam from sls.exams where course = module_id and id = (payload->>'examId')::uuid;
      if found and exam.version::text is distinct from nullif(payload->>'examVersion','') then
        raise sqlstate 'PT409' using message = 'This exam was updated. Reopen it before submitting your answers.';
      end if;
    end if;
  end if;

  response := sls.workspace_before_module_editing(action,payload);
  if action = 'edit' and me.role = 'teacher' and payload ? 'monthlyFee' then
    -- The earlier edit handler validates the fee but returns {ok:true}, not a course ID.
    update sls.courses set monthly_fee = (payload->>'monthlyFee')::numeric
      where id = module_id and owner = me.id and monthly_fee is distinct from (payload->>'monthlyFee')::numeric;
  elsif action = 'course' and jsonb_array_length(response->'exams') > 0 then
    response := jsonb_set(response,'{exams}',(
      select jsonb_agg(item || jsonb_build_object('version',e.version) ||
        case when me.role = 'teacher' then jsonb_build_object('questions',e.questions) else '{}'::jsonb end order by ord)
      from jsonb_array_elements(response->'exams') with ordinality as items(item,ord)
      join sls.exams e on e.course = module_id and e.id = (item->>'id')::uuid));
  end if;
  return response;
end $$;

revoke all on function public.sls_workspace(text,jsonb) from public,anon,authenticated;
grant execute on function public.sls_workspace(text,jsonb) to authenticated;

commit;
