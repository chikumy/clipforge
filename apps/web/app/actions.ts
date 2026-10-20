"use server";

import { assetStorageKey, createWorkspaceSchema, inviteSchema, signInSchema, signUpSchema, uploadRequestSchema } from "@clipforge/shared";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { safeNext } from "@/lib/safe-next";
import { enqueueProbe, enqueueTranscribe, mediaLimits, presignUpload, storedSize } from "@/lib/storage";
import { createClient } from "@/lib/supabase/server";

const text = (f: FormData, k: string) => String(f.get(k) ?? "");
const fail = (path: string, message: string, extra = ""): never =>
  redirect(`${path}?error=${encodeURIComponent(message)}${extra}`);

/** Generic message on purpose: do not reveal whether an email is registered. */
const BAD_LOGIN = "Incorrect email or password.";

export async function signUp(f: FormData) {
  const parsed = signUpSchema.safeParse({ email: text(f, "email"), password: text(f, "password"), displayName: text(f, "displayName") });
  if (!parsed.success) fail("/signup", parsed.error.issues[0]?.message ?? "Check the form and try again.");
  const { email, password, displayName } = parsed.data!;
  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    email, password,
    options: { data: { display_name: displayName }, emailRedirectTo: `${env.NEXT_PUBLIC_SITE_URL}/auth/callback` },
  });
  if (error) fail("/signup", "We could not create that account. Try a different email or a stronger password.");
  redirect("/login?notice=" + encodeURIComponent("Check your email to confirm your account, then sign in."));
}

export async function signIn(f: FormData) {
  const next = safeNext(f.get("next"));
  const parsed = signInSchema.safeParse({ email: text(f, "email"), password: text(f, "password") });
  if (!parsed.success) fail("/login", BAD_LOGIN);
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data!);
  if (error) fail("/login", BAD_LOGIN, `&next=${encodeURIComponent(next)}`);
  redirect(next);
}

export async function requestPasswordReset(f: FormData) {
  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(text(f, "email").trim().toLowerCase(), {
    redirectTo: `${env.NEXT_PUBLIC_SITE_URL}/auth/callback?next=/reset-password`,
  });
  redirect("/login?notice=" + encodeURIComponent("If that address has an account, a reset link is on its way."));
}

export async function updatePassword(f: FormData) {
  const password = text(f, "password");
  if (password.length < 10 || password.length > 128) fail("/reset-password", "Use 10 to 128 characters.");
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) fail("/reset-password", "Could not update the password. Request a new reset link.");
  redirect("/onboarding");
}

export async function createWorkspace(f: FormData) {
  const parsed = createWorkspaceSchema.safeParse({ name: text(f, "name"), kind: text(f, "kind"), timezone: text(f, "timezone") || "UTC" });
  if (!parsed.success) fail("/onboarding", "Enter a workspace name and choose a type.");
  const { name, kind, timezone } = parsed.data!;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_workspace", { p_name: name, p_kind: kind, p_timezone: timezone }).single<{ slug: string }>();
  if (error || !data) fail("/onboarding", error?.message?.startsWith("You already own") ? error.message : "Could not create the workspace.");
  redirect(`/w/${data!.slug}`);
}

export async function inviteMember(slug: string, f: FormData) {
  const path = `/w/${slug}/members`;
  const parsed = inviteSchema.safeParse({ email: text(f, "email"), role: text(f, "role") });
  if (!parsed.success) fail(path, parsed.error.issues[0]?.message ?? "Enter a valid email and role.");
  const supabase = await createClient();
  const { data: ws } = await supabase.from("workspaces").select("id").eq("slug", slug).single();
  if (!ws) fail(path, "Workspace not found.");
  const { data: token, error } = await supabase.rpc("create_invitation", { p_workspace: ws!.id, p_email: parsed.data!.email, p_role: parsed.data!.role });
  if (error) fail(path, error.message.length < 120 ? error.message : "Could not create the invitation.");
  // No mail provider is wired up in Milestone 1, so the owner shares the link themselves.
  const h = await headers();
  const origin = h.get("origin") ?? env.NEXT_PUBLIC_SITE_URL;
  redirect(`${path}?invite=${encodeURIComponent(`${origin}/invite/accept?token=${token}`)}`);
}

export async function revokeInvitation(slug: string, f: FormData) {
  const supabase = await createClient();
  await supabase.rpc("revoke_invitation", { p_invitation: text(f, "id") });
  redirect(`/w/${slug}/members`);
}

export async function changeRole(slug: string, f: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.from("workspace_members").update({ role: text(f, "role") })
    .eq("workspace_id", text(f, "workspace")).eq("user_id", text(f, "user"));
  redirect(`/w/${slug}/members${error ? `?error=${encodeURIComponent(error.message.length < 120 ? error.message : "Could not change the role.")}` : ""}`);
}

export async function removeMember(slug: string, f: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.from("workspace_members").delete()
    .eq("workspace_id", text(f, "workspace")).eq("user_id", text(f, "user"));
  redirect(`/w/${slug}/members${error ? `?error=${encodeURIComponent(error.message.length < 120 ? error.message : "Could not remove the member.")}` : ""}`);
}

export async function acceptInvitation(f: FormData) {
  const supabase = await createClient();
  const { data: wsId, error } = await supabase.rpc("accept_invitation", { p_token: text(f, "token") });
  if (error) fail("/onboarding", error.message.length < 120 ? error.message : "Could not accept the invitation.");
  const { data: ws } = await supabase.from("workspaces").select("slug").eq("id", wsId).single();
  redirect(ws ? `/w/${ws.slug}` : "/onboarding");
}

export async function updateProfile(f: FormData) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const name = text(f, "displayName").trim().slice(0, 80);
  if (user) await supabase.from("profiles").update({ display_name: name || null }).eq("id", user.id);
  redirect(safeNext(f.get("back"), "/onboarding"));
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}

export type StartUpload =
  | { ok: true; assetId: string; url: string; fields: Record<string, string> }
  | { ok: false; error: string };

const short = (m: string, fallback: string) => (m.length < 120 ? m : fallback);

/** Step 1 of an upload: record it, then hand the browser a form post that S3 will accept only for this file. */
export async function startUpload(slug: string, input: { filename: string; contentType: string; size: number }): Promise<StartUpload> {
  const parsed = uploadRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Choose an MP4, MOV, WebM or MKV video." };
  const { filename, contentType, size } = parsed.data;
  const limits = mediaLimits();
  if (size > limits.maxBytes) return { ok: false, error: `That file is larger than the ${Math.round(limits.maxBytes / 1024 ** 3 * 10) / 10} GB limit.` };

  const supabase = await createClient();
  const { data: ws } = await supabase.from("workspaces").select("id").eq("slug", slug).single();
  if (!ws) return { ok: false, error: "Workspace not found." };
  const { data: asset, error } = await supabase
    .rpc("create_asset_upload", { p_workspace: ws.id, p_filename: filename, p_content_type: contentType, p_size: size })
    .single<{ id: string; storage_key: string }>();
  if (error || !asset) return { ok: false, error: short(error?.message ?? "", "Could not start the upload.") };

  const post = await presignUpload(asset.storage_key, contentType, size);
  return { ok: true, assetId: asset.id, url: post.url, fields: post.fields };
}

/** Step 2: the browser says it finished. Do not trust that; look at storage, then queue the check. */
export async function completeUpload(slug: string, assetId: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: asset } = await supabase.from("assets").select("id, workspace_id, size_bytes").eq("id", assetId).single();
  if (!asset) return { ok: false, error: "Upload not found." };

  const actual = await storedSize(assetStorageKey(asset.workspace_id, asset.id));
  if (actual !== Number(asset.size_bytes)) return { ok: false, error: "The upload did not finish. Please try again." };

  const { data: jobId, error } = await supabase.rpc("complete_asset_upload", { p_asset: asset.id });
  if (error || !jobId) return { ok: false, error: short(error?.message ?? "", "Could not finish the upload.") };
  // If Redis is down the job stays `queued` in Postgres and the worker's reconcile loop picks it up.
  await enqueueProbe(jobId as string).catch((e) => console.error("enqueue failed; reconcile will retry", String(e)));
  revalidatePath(`/w/${slug}/assets`);
  return { ok: true };
}

/** Asks for a transcript of a ready video. The database checks role, status and audio; Redis is only a nudge. */
export async function requestTranscription(slug: string, assetId: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: jobId, error } = await supabase.rpc("request_transcription", { p_asset: assetId });
  if (error || !jobId) return { ok: false, error: short(error?.message ?? "", "Could not start the transcript.") };
  await enqueueTranscribe(jobId as string).catch((e) => console.error("enqueue failed; reconcile will retry", String(e)));
  revalidatePath(`/w/${slug}/assets`);
  return { ok: true };
}
