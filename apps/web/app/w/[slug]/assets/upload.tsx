"use client";

import { contentTypeFor } from "@clipforge/shared";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { completeUpload, startUpload } from "@/app/actions";

/** Re-reads the list while any video is still being checked, so status updates appear on their own. */
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}

function postToStorage(url: string, fields: Record<string, string>, file: File, onProgress: (pct: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append("file", file); // must come last for S3
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("The upload was refused by storage.")));
    xhr.onerror = () => reject(new Error("The upload was interrupted. Check your connection and try again."));
    xhr.send(form);
  });
}

export function UploadForm({ slug }: { slug: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string>();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const input = e.currentTarget.elements.namedItem("file") as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    setBusy(true); setError(undefined); setPct(0);
    try {
      const start = await startUpload(slug, { filename: file.name, contentType: contentTypeFor(file.name, file.type), size: file.size });
      if (!start.ok) throw new Error(start.error);
      await postToStorage(start.url, start.fields, file, setPct);
      const done = await completeUpload(slug, start.assetId);
      if (!done.ok) throw new Error(done.error);
      input.value = "";
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-3">
      <label className="block text-sm font-medium">
        Upload a video (MP4, MOV, WebM or MKV)
        <input name="file" type="file" required accept=".mp4,.m4v,.mov,.webm,.mkv,video/*" disabled={busy} className="input mt-1 font-normal" />
      </label>
      {busy && <progress value={pct} max={100} aria-label="Upload progress" className="w-full" />}
      {error && <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm">{error}</p>}
      <button className="btn" disabled={busy}>{busy ? `Uploading ${pct}%` : "Upload"}</button>
    </form>
  );
}
