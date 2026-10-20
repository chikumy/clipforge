import { can, type Role } from "@clipforge/shared";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AutoRefresh, TranscribeButton, UploadForm } from "./upload";

type Asset = {
  id: string; original_filename: string; size_bytes: number; status: string; rejection_reason: string | null; created_at: string;
  probe: { durationSeconds: number; width: number; height: number; videoCodec: string; audioCodec: string | null } | null;
};

const LABEL: Record<string, string> = {
  pending_upload: "Waiting for upload", uploaded: "Queued for checking", validating: "Checking", ready: "Ready", rejected: "Rejected", error: "Check failed",
};
const ACTIVE = ["uploaded", "validating"];

type Transcript = { asset_id: string; is_mock: boolean; segments: { start: number; end: number; text: string }[] };
type TJob = { asset_id: string; status: string; error: string | null };

const size = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(1)} MB`);
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export default async function Assets({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: ws } = await supabase.from("workspaces").select("id").eq("slug", slug).single();
  if (!ws) notFound();
  const { data: me } = await supabase.from("workspace_members").select("role").eq("workspace_id", ws.id).eq("user_id", user!.id).single();
  const { data } = await supabase.from("assets")
    .select("id, original_filename, size_bytes, status, rejection_reason, created_at, probe")
    .order("created_at", { ascending: false }).limit(50);
  const assets = (data ?? []) as Asset[];
  const { data: tr } = await supabase.from("transcripts").select("asset_id, is_mock, segments");
  const transcripts = new Map(((tr ?? []) as Transcript[]).map((t) => [t.asset_id, t]));
  // Newest first, so the first row seen per asset is its latest transcription job.
  const { data: tj } = await supabase.from("render_jobs").select("asset_id, status, error").eq("kind", "transcribe").order("created_at", { ascending: false }).limit(200);
  const tjobs = new Map<string, TJob>();
  for (const j of (tj ?? []) as TJob[]) if (!tjobs.has(j.asset_id)) tjobs.set(j.asset_id, j);
  const transcribing = [...tjobs.values()].some((j) => j.status === "queued" || j.status === "running");
  const canTranscribe = can(me?.role as Role, "assets.upload");

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Videos</h1>
      <AutoRefresh active={transcribing || assets.some((a) => ACTIVE.includes(a.status))} />
      {can(me?.role as Role, "assets.upload")
        ? <UploadForm slug={slug} />
        : <p className="muted text-sm">Your role can view videos but not upload them.</p>}
      {assets.length === 0 ? (
        <div className="card"><h2 className="font-semibold">No videos yet</h2><p className="muted mt-1 text-sm">Upload a long video to start. Clip detection comes in a later milestone.</p></div>
      ) : (
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Uploaded videos</caption>
          <thead className="muted"><tr><th scope="col" className="py-2">File</th><th scope="col">Size</th><th scope="col">Status</th><th scope="col">Details</th><th scope="col">Transcript</th></tr></thead>
          <tbody>
            {assets.map((a) => (
              <tr key={a.id} className="border-t border-[var(--line)] align-top">
                <td className="py-2 break-all">{a.original_filename}</td>
                <td>{size(a.size_bytes)}</td>
                <td>{LABEL[a.status] ?? a.status}</td>
                <td>
                  {a.probe && `${clock(a.probe.durationSeconds)} · ${a.probe.width}×${a.probe.height} · ${a.probe.videoCodec}`}
                  {a.rejection_reason}
                  {a.status === "error" && "Something went wrong on our side. Try uploading again."}
                </td>
                <td>
                  <TranscriptCell a={a} slug={slug} t={transcripts.get(a.id)} job={tjobs.get(a.id)} canTranscribe={canTranscribe} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TranscriptCell({ a, slug, t, job, canTranscribe }: { a: Asset; slug: string; t?: Transcript; job?: TJob; canTranscribe: boolean }) {
  if (t) {
    return (
      <details>
        <summary className="cursor-pointer">View ({t.segments.length} segments)</summary>
        {t.is_mock && <p role="note" className="mt-1 text-sm font-semibold">Development placeholder text. This is not real speech recognition.</p>}
        <ol className="mt-1 space-y-1">
          {t.segments.map((s, i) => <li key={i}><span className="muted">{clock(s.start)}</span> {s.text}</li>)}
        </ol>
      </details>
    );
  }
  if (job && (job.status === "queued" || job.status === "running")) return <>Transcribing…</>;
  if (a.status !== "ready") return null;
  if (!a.probe?.audioCodec) return <span className="muted">No audio track</span>;
  return (
    <>
      {job?.status === "failed" && <p className="text-sm">{job.error}</p>}
      {canTranscribe && <TranscribeButton slug={slug} assetId={a.id} />}
    </>
  );
}
