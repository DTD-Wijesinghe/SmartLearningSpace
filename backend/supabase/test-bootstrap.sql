-- Apply only to an isolated local PostgreSQL test instance.
create role anon;
create role authenticated;
create schema auth;
create table auth.users (
  id uuid primary key,
  email text not null,
  raw_user_meta_data jsonb not null
);
create function auth.uid() returns uuid language sql stable
  as $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
