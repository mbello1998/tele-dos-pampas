-- 0023: every new auth user gets a profile, as a plain active client.
--
-- Sign-up (e-mail OTP today, phone later) creates a row in auth.users. This trigger creates the matching
-- profiles row in the SAME transaction, so there is never a signed-in user without a profile, and users
-- created from the Studio or the admin API get one too.
--
-- WHAT THIS MUST NEVER DO: read the role (or the status) from the new user's metadata. raw_user_meta_data is
-- whatever the person signing up sent in signInWithOtp({ options: { data } }): it is user-controlled, so a
-- role taken from it would let anyone register as admin. The values are literals. Couriers, merchants and
-- fleet owners are elevated by an admin, after the fact (the admin policies on profiles); never at sign-up.
--
-- What already protects the role AFTER sign-up is not touched here: restrict_update_columns (0009) refuses
-- any UPDATE of role/status/id by anon/authenticated unless the actor is an active admin. A second trigger
-- for it would only conflict with that one.
--
-- `on conflict do nothing`: if a profile somehow exists already, the sign-up must still succeed (a failing
-- trigger here would turn into "Database error saving new user" for every person trying to register).
--
-- The function lives in `private` (not exposed by PostgREST) and is revoked from everyone: Postgres checks
-- EXECUTE on a trigger function only when the trigger is created, not when it fires, so GoTrue
-- (supabase_auth_admin) does not need a grant. Proven against the real GoTrue path by tests/e2e/auth.spec.ts.

create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, role, status)
  values (new.id, 'client', 'active')
  on conflict (id) do nothing;
  return new;
end
$$;
revoke all on function private.handle_new_user() from public, anon, authenticated, service_role;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Accounts that already existed without a profile (none today; this keeps a replay on a populated project
-- consistent). They become plain clients, never anything else.
insert into public.profiles (id, role, status)
select u.id, 'client', 'active' from auth.users u
on conflict (id) do nothing;
