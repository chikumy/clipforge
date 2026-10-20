-- Milestone 1: profiles, workspaces, membership, invitations, audit log, RLS.
-- Every function is security definer with an empty search_path, so all names are schema-qualified.

create extension if not exists pgcrypto with schema extensions;

create type public.workspace_role as enum ('owner', 'admin', 'editor', 'approver', 'viewer');
create type public.workspace_kind as enum ('creator', 'business', 'agency');

-- ---------------------------------------------------------------- tables

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 80),
  avatar_path text check (char_length(avatar_path) <= 512),
  locale text not null default 'en' check (char_length(locale) <= 16),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
  kind public.workspace_kind not null,
  timezone text not null default 'UTC',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.workspace_role not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_id_idx on public.workspace_members (user_id);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 254),
  role public.workspace_role not null check (role <> 'owner'),
  token_hash bytea not null unique, -- sha256 of the token; the token itself is never stored
  invited_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index invitations_pending_email_idx
  on public.invitations (workspace_id, lower(email)) where accepted_at is null;

-- No FK on workspace_id: audit history must survive workspace deletion.
create table public.audit_logs (
  id bigint generated always as identity primary key,
  workspace_id uuid,
  actor_id uuid,
  action text not null,
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_workspace_created_idx on public.audit_logs (workspace_id, created_at desc);

-- ---------------------------------------------------------------- helpers

create function public.is_member(ws uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = auth.uid()
  );
$$;

create function public.has_role(ws uuid, roles public.workspace_role[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = auth.uid() and m.role = any (roles)
  );
$$;

create function public.shares_workspace(other uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members a
    join public.workspace_members b on b.workspace_id = a.workspace_id
    where a.user_id = auth.uid() and b.user_id = other
  );
$$;

create function public.write_audit(ws uuid, act text, target uuid, meta jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_logs (workspace_id, actor_id, action, target_id, metadata)
  values (ws, auth.uid(), act, target, coalesce(meta, '{}'::jsonb));
$$;
revoke execute on function public.write_audit(uuid, text, uuid, jsonb) from public, anon, authenticated;

create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger workspaces_touch before update on public.workspaces
  for each row execute function public.touch_updated_at();
create trigger workspace_members_touch before update on public.workspace_members
  for each row execute function public.touch_updated_at();

-- Profile row for every new auth user.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(new.raw_user_meta_data ->> 'display_name', 80));
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- membership guards

-- Owners are the only ones who can create, change or remove an owner, and a workspace
-- always keeps at least one owner (except when the workspace itself is being deleted).
create function public.guard_membership_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  remaining_owners int;
begin
  -- Cascading delete from the workspace: nothing to protect.
  if tg_op = 'DELETE' and not exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    return old;
  end if;

  -- Service role / migrations (no end user) are trusted.
  if auth.uid() is not null then
    if tg_op = 'UPDATE' and (old.role = 'owner' or new.role = 'owner')
       and not public.has_role(old.workspace_id, array['owner']::public.workspace_role[]) then
      raise exception 'Only an owner can grant or remove the owner role.' using errcode = 'P0001';
    end if;
    if tg_op = 'DELETE' and old.role = 'owner' and old.user_id <> auth.uid()
       and not public.has_role(old.workspace_id, array['owner']::public.workspace_role[]) then
      raise exception 'Only an owner can remove another owner.' using errcode = 'P0001';
    end if;
  end if;

  if old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner') then
    select count(*) into remaining_owners from public.workspace_members m
    where m.workspace_id = old.workspace_id and m.role = 'owner' and m.user_id <> old.user_id;
    if remaining_owners = 0 then
      raise exception 'A workspace must keep at least one owner.' using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger workspace_members_guard before update or delete on public.workspace_members
  for each row execute function public.guard_membership_change();

create function public.audit_membership() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform public.write_audit(new.workspace_id, 'member.added', new.user_id, jsonb_build_object('role', new.role));
  elsif tg_op = 'UPDATE' and old.role is distinct from new.role then
    perform public.write_audit(new.workspace_id, 'member.role_changed', new.user_id,
      jsonb_build_object('from', old.role, 'to', new.role));
  elsif tg_op = 'DELETE' then
    perform public.write_audit(old.workspace_id, 'member.removed', old.user_id, jsonb_build_object('role', old.role));
  end if;
  return null;
end;
$$;

create trigger workspace_members_audit after insert or update or delete on public.workspace_members
  for each row execute function public.audit_membership();

-- Audit rows are immutable for everyone, service role included.
create function public.reject_audit_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_logs is append-only' using errcode = 'P0001';
end;
$$;

create trigger audit_logs_immutable before update or delete on public.audit_logs
  for each row execute function public.reject_audit_change();
create trigger audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function public.reject_audit_change();

-- ---------------------------------------------------------------- RPCs

create function public.create_workspace(p_name text, p_kind public.workspace_kind, p_timezone text default 'UTC')
returns public.workspaces
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  base text;
  ws public.workspaces;
begin
  if uid is null then
    raise exception 'Not signed in.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.workspace_members m where m.user_id = uid and m.role = 'owner') >= 20 then
    raise exception 'You already own the maximum number of workspaces.' using errcode = 'P0001';
  end if;
  begin
    perform now() at time zone p_timezone;
  exception when others then
    raise exception 'Unknown timezone.' using errcode = 'P0001';
  end;

  base := left(trim(both '-' from regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g')), 40);
  if base = '' then base := 'workspace'; end if;

  insert into public.workspaces (name, slug, kind, timezone, created_by)
  values (btrim(p_name), base || '-' || encode(extensions.gen_random_bytes(3), 'hex'), p_kind, p_timezone, uid)
  returning * into ws;

  insert into public.workspace_members (workspace_id, user_id, role) values (ws.id, uid, 'owner');
  perform public.write_audit(ws.id, 'workspace.created', ws.id, jsonb_build_object('kind', p_kind));
  return ws;
end;
$$;

-- Returns the raw token once; only its hash is stored.
create function public.create_invitation(p_workspace uuid, p_email text, p_role public.workspace_role)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  token text := encode(extensions.gen_random_bytes(32), 'hex');
  inv_id uuid;
begin
  if not public.has_role(p_workspace, array['owner', 'admin']::public.workspace_role[]) then
    raise exception 'Only owners and admins can invite members.' using errcode = 'P0001';
  end if;
  if p_role = 'owner' then
    raise exception 'Invite as admin, then promote to owner.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.invitations i
      where i.workspace_id = p_workspace and i.accepted_at is null and i.expires_at > now()) >= 50 then
    raise exception 'Too many pending invitations.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.workspace_members m join auth.users u on u.id = m.user_id
             where m.workspace_id = p_workspace and lower(u.email) = lower(btrim(p_email))) then
    raise exception 'That person is already a member.' using errcode = 'P0001';
  end if;

  -- Replace any earlier pending invite for the same address.
  delete from public.invitations i
  where i.workspace_id = p_workspace and lower(i.email) = lower(btrim(p_email)) and i.accepted_at is null;

  insert into public.invitations (workspace_id, email, role, token_hash, invited_by)
  values (p_workspace, lower(btrim(p_email)), p_role, extensions.digest(token, 'sha256'), auth.uid())
  returning id into inv_id;

  perform public.write_audit(p_workspace, 'invitation.created', inv_id,
    jsonb_build_object('email', lower(btrim(p_email)), 'role', p_role));
  return token;
end;
$$;

create function public.accept_invitation(p_token text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  user_email text;
  inv public.invitations;
begin
  if uid is null then
    raise exception 'Not signed in.' using errcode = 'P0001';
  end if;
  select u.email into user_email from auth.users u where u.id = uid;

  select * into inv from public.invitations i
  where i.token_hash = extensions.digest(coalesce(p_token, ''), 'sha256')
  for update;

  if inv.id is null or inv.accepted_at is not null or inv.expires_at <= now() then
    raise exception 'This invitation is invalid or has expired.' using errcode = 'P0001';
  end if;
  if lower(inv.email) <> lower(coalesce(user_email, '')) then
    raise exception 'This invitation was sent to a different email address.' using errcode = 'P0001';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (inv.workspace_id, uid, inv.role)
  on conflict (workspace_id, user_id) do nothing;

  update public.invitations set accepted_at = now(), accepted_by = uid where id = inv.id;
  perform public.write_audit(inv.workspace_id, 'invitation.accepted', inv.id, '{}'::jsonb);
  return inv.workspace_id;
end;
$$;

create function public.revoke_invitation(p_invitation uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid;
begin
  select i.workspace_id into ws from public.invitations i where i.id = p_invitation and i.accepted_at is null;
  if ws is null or not public.has_role(ws, array['owner', 'admin']::public.workspace_role[]) then
    raise exception 'Invitation not found.' using errcode = 'P0001';
  end if;
  delete from public.invitations where id = p_invitation;
  perform public.write_audit(ws, 'invitation.revoked', p_invitation, '{}'::jsonb);
end;
$$;

revoke execute on function public.create_workspace(text, public.workspace_kind, text) from public, anon;
revoke execute on function public.create_invitation(uuid, text, public.workspace_role) from public, anon;
revoke execute on function public.accept_invitation(text) from public, anon;
revoke execute on function public.revoke_invitation(uuid) from public, anon;
grant execute on function public.create_workspace(text, public.workspace_kind, text) to authenticated;
grant execute on function public.create_invitation(uuid, text, public.workspace_role) to authenticated;
grant execute on function public.accept_invitation(text) to authenticated;
grant execute on function public.revoke_invitation(uuid) to authenticated;

-- Members can see each other's email inside a shared workspace (needed for the members page).
create function public.workspace_member_list(p_workspace uuid)
returns table (user_id uuid, email text, display_name text, role public.workspace_role, joined_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select m.user_id, u.email::text, p.display_name, m.role, m.created_at
  from public.workspace_members m
  join auth.users u on u.id = m.user_id
  left join public.profiles p on p.id = m.user_id
  where m.workspace_id = p_workspace and public.is_member(p_workspace)
  order by m.created_at;
$$;
revoke execute on function public.workspace_member_list(uuid) from public, anon;
grant execute on function public.workspace_member_list(uuid) to authenticated;

-- ---------------------------------------------------------------- RLS

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.invitations enable row level security;
alter table public.audit_logs enable row level security;

-- Nothing here is for signed-out visitors.
revoke all on public.profiles, public.workspaces, public.workspace_members, public.invitations, public.audit_logs from anon;
revoke update, delete, truncate on public.audit_logs from authenticated;

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_workspace(id));
create policy profiles_insert on public.profiles for insert to authenticated
  with check (false); -- created by handle_new_user()
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_delete on public.profiles for delete to authenticated
  using (false); -- removed by account deletion (cascade from auth.users)

-- workspaces
create policy workspaces_select on public.workspaces for select to authenticated
  using (public.is_member(id));
create policy workspaces_insert on public.workspaces for insert to authenticated
  with check (false); -- use create_workspace()
create policy workspaces_update on public.workspaces for update to authenticated
  using (public.has_role(id, array['owner', 'admin']::public.workspace_role[]))
  with check (public.has_role(id, array['owner', 'admin']::public.workspace_role[]));
create policy workspaces_delete on public.workspaces for delete to authenticated
  using (public.has_role(id, array['owner']::public.workspace_role[]));

-- created_by and slug are not user-editable.
revoke update on public.workspaces from authenticated;
grant update (name, timezone, kind) on public.workspaces to authenticated;

-- workspace_members
create policy members_select on public.workspace_members for select to authenticated
  using (public.is_member(workspace_id));
create policy members_insert on public.workspace_members for insert to authenticated
  with check (false); -- use create_workspace() / accept_invitation()
create policy members_update on public.workspace_members for update to authenticated
  using (public.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
  with check (public.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));
create policy members_delete on public.workspace_members for delete to authenticated
  using (user_id = auth.uid() or public.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

revoke update on public.workspace_members from authenticated;
grant update (role) on public.workspace_members to authenticated;

-- invitations (token_hash is never readable by clients)
create policy invitations_select on public.invitations for select to authenticated
  using (public.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));
create policy invitations_insert on public.invitations for insert to authenticated
  with check (false); -- use create_invitation()
create policy invitations_update on public.invitations for update to authenticated
  using (false);
create policy invitations_delete on public.invitations for delete to authenticated
  using (false); -- use revoke_invitation()
revoke select on public.invitations from authenticated;
grant select (id, workspace_id, email, role, invited_by, expires_at, accepted_at, created_at)
  on public.invitations to authenticated;

-- audit_logs
create policy audit_select on public.audit_logs for select to authenticated
  using (public.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));
create policy audit_insert on public.audit_logs for insert to authenticated
  with check (false); -- written only by security definer functions
