begin;
alter table sls.live_sessions add column host uuid references sls.profiles(id);
update sls.live_sessions l set host = c.owner from sls.courses c where l.course = c.id;
alter table sls.live_sessions alter column host set not null;
create unique index live_sessions_one_per_host on sls.live_sessions(host) where ended_at is null;

create function sls.assign_live_host() returns trigger
language plpgsql set search_path = '' as $$
begin
  select owner into new.host from sls.courses where id = new.course;
  return new;
end $$;
revoke all on function sls.assign_live_host() from public;
create trigger assign_live_host before insert on sls.live_sessions
  for each row execute function sls.assign_live_host();

create function sls.guard_live_course_archive() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists(select 1 from sls.live_sessions where course = new.id and ended_at is null) then
    raise sqlstate 'PT409' using message = 'End the live class before archiving this module.';
  end if;
  return new;
end $$;
revoke all on function sls.guard_live_course_archive() from public;
create trigger guard_live_course_archive before update of status on sls.courses
  for each row when (new.status = 'suspended' and old.status <> 'suspended')
  execute function sls.guard_live_course_archive();
commit;
