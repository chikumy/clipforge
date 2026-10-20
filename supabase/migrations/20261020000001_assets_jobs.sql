-- Milestone 2a: source-media assets and background job records.
-- Clients never write these tables directly: uploads start and finish through RPCs, and the
-- worker (a privileged database role that bypasses RLS) is the only writer of results.

create type public.asset_status as enum ('pending_upload', 'uploaded', 'validating', 'ready', 'rejected', 'error');
create type public.job_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  uploaded_by uuid references auth.users (id) on delete set null,
  kind text not null default 'source_video' check (kind in ('source_video')),
  original_filename text not null check (char_length(original_filename) between 1 and 200),
  content_type text not null check (content_type in ('video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska')),
  size_bytes bigint not null check (size_bytes between 1 and 5368709120), -- hard ceiling 5 GiB; the app enforces its lower, configurable limit
  storage_key text not null unique,
  status public.asset_status not null default 'pending_upload',
  probe jsonb,
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index assets_workspace_created_idx on public.assets (workspace_id, created_at desc);

create table public.render_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  asset_id uuid not null references public.assets (id) on delete cascade,
  kind text not null check (kind in ('probe')),
  status public.job_status not null default 'queued',
  progress smallint not null default 0 check (progress between 0 and 100),
  attempts int not null default 0,
  error text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index render_jobs_workspace_created_idx on public.render_jobs (workspace_id, created_at desc);
create index render_jobs_queued_idx on public.render_jobs (created_at) where status = 'queued';
-- At most one active job per asset and kind: a double click or retried request cannot queue twice.
create unique index render_jobs_one_active_idx on public.render_jobs (asset_id, kind) where status in ('queued', 'running');

create trigger assets_touch before update on public.assets
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- RPCs

-- The storage key is generated here from ids only, never from the client's filename.
create function public.create_asset_upload(p_workspace uuid, p_filename text, p_content_type text, p_size bigint)
returns public.assets
language plpgsql security definer set search_path = '' as $$
declare
  a public.assets;
  new_id uuid := gen_random_uuid();
begin
  if not public.has_role(p_workspace, array['owner', 'admin', 'editor']::public.workspace_role[]) then
    raise exception 'You do not have permission to upload in this workspace.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.assets x
      where x.workspace_id = p_workspace and x.status = 'pending_upload' and x.created_at > now() - interval '1 day') >= 20 then
    raise exception 'Too many unfinished uploads. Finish or wait before starting another.' using errcode = 'P0001';
  end if;

  insert into public.assets (id, workspace_id, uploaded_by, original_filename, content_type, size_bytes, storage_key)
  values (new_id, p_workspace, auth.uid(), left(btrim(p_filename), 200), p_content_type, p_size,
          'workspaces/' || p_workspace || '/assets/' || new_id || '/source')
  returning * into a;

  perform public.write_audit(p_workspace, 'asset.upload_started', a.id,
    jsonb_build_object('size_bytes', p_size, 'content_type', p_content_type));
  return a;
end;
$$;

-- Called after the web server has confirmed the object exists with the declared size.
-- Idempotent: repeating it returns the same job.
create function public.complete_asset_upload(p_asset uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  a public.assets;
  job_id uuid;
begin
  select * into a from public.assets x where x.id = p_asset for update;
  if a.id is null or not public.has_role(a.workspace_id, array['owner', 'admin', 'editor']::public.workspace_role[]) then
    raise exception 'Upload not found.' using errcode = 'P0001';
  end if;

  if a.status = 'pending_upload' then
    update public.assets set status = 'uploaded' where id = a.id;
    insert into public.render_jobs (workspace_id, asset_id, kind, created_by)
    values (a.workspace_id, a.id, 'probe', auth.uid())
    returning id into job_id;
    perform public.write_audit(a.workspace_id, 'asset.upload_completed', a.id, '{}'::jsonb);
    return job_id;
  end if;

  select j.id into job_id from public.render_jobs j
  where j.asset_id = a.id and j.kind = 'probe' order by j.created_at desc limit 1;
  return job_id;
end;
$$;

revoke execute on function public.create_asset_upload(uuid, text, text, bigint) from public, anon;
revoke execute on function public.complete_asset_upload(uuid) from public, anon;
grant execute on function public.create_asset_upload(uuid, text, text, bigint) to authenticated;
grant execute on function public.complete_asset_upload(uuid) to authenticated;

-- ---------------------------------------------------------------- RLS

alter table public.assets enable row level security;
alter table public.render_jobs enable row level security;
revoke all on public.assets, public.render_jobs from anon;

create policy assets_select on public.assets for select to authenticated
  using (public.is_member(workspace_id));
create policy assets_insert on public.assets for insert to authenticated
  with check (false); -- use create_asset_upload()
create policy assets_update on public.assets for update to authenticated
  using (false); -- results are written by the worker
create policy assets_delete on public.assets for delete to authenticated
  using (false); -- deletion needs storage cleanup; added with the retention workflow

create policy jobs_select on public.render_jobs for select to authenticated
  using (public.is_member(workspace_id));
create policy jobs_insert on public.render_jobs for insert to authenticated
  with check (false); -- use complete_asset_upload()
create policy jobs_update on public.render_jobs for update to authenticated
  using (false);
create policy jobs_delete on public.render_jobs for delete to authenticated
  using (false);

-- storage_key is internal; clients get files through short-lived signed URLs only.
revoke select on public.assets from authenticated;
grant select (id, workspace_id, uploaded_by, kind, original_filename, content_type, size_bytes,
              status, probe, rejection_reason, created_at, updated_at) on public.assets to authenticated;
