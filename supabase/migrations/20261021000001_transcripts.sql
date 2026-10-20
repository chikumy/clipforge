-- Milestone 2b: transcripts for ready videos. Clients request a transcription through an RPC;
-- the worker (RLS-bypassing role) is the only writer of transcript rows.

alter table public.render_jobs drop constraint render_jobs_kind_check;
alter table public.render_jobs add constraint render_jobs_kind_check check (kind in ('probe', 'transcribe'));

create table public.transcripts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  asset_id uuid not null unique references public.assets (id) on delete cascade,
  provider text not null,
  -- True when the text was produced by the development stand-in, not by speech recognition.
  is_mock boolean not null default false,
  language text,
  segments jsonb not null check (jsonb_typeof(segments) = 'array'),
  created_at timestamptz not null default now()
);
create index transcripts_workspace_idx on public.transcripts (workspace_id);

alter table public.transcripts enable row level security;
revoke all on public.transcripts from anon;
create policy transcripts_select on public.transcripts for select to authenticated using (public.is_member(workspace_id));
create policy transcripts_insert on public.transcripts for insert to authenticated with check (false);
create policy transcripts_update on public.transcripts for update to authenticated using (false);
create policy transcripts_delete on public.transcripts for delete to authenticated using (false);

-- Idempotent while a job is active: a double click returns the same job.
create function public.request_transcription(p_asset uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  a public.assets;
  job_id uuid;
begin
  select * into a from public.assets x where x.id = p_asset;
  if a.id is null or not public.has_role(a.workspace_id, array['owner', 'admin', 'editor']::public.workspace_role[]) then
    raise exception 'Video not found.' using errcode = 'P0001';
  end if;
  if a.status <> 'ready' then
    raise exception 'The video must finish checking before it can be transcribed.' using errcode = 'P0001';
  end if;
  if a.probe ->> 'audioCodec' is null then
    raise exception 'This video has no audio track to transcribe.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.transcripts t where t.asset_id = a.id) then
    raise exception 'This video already has a transcript.' using errcode = 'P0001';
  end if;

  insert into public.render_jobs (workspace_id, asset_id, kind, created_by)
  values (a.workspace_id, a.id, 'transcribe', auth.uid())
  on conflict (asset_id, kind) where status in ('queued', 'running') do nothing
  returning id into job_id;

  if job_id is null then
    select j.id into job_id from public.render_jobs j
    where j.asset_id = a.id and j.kind = 'transcribe' and j.status in ('queued', 'running');
  else
    perform public.write_audit(a.workspace_id, 'asset.transcription_requested', a.id, '{}'::jsonb);
  end if;
  return job_id;
end;
$$;

revoke execute on function public.request_transcription(uuid) from public, anon;
grant execute on function public.request_transcription(uuid) to authenticated;
