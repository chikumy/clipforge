import { can, type Role } from "@clipforge/shared";
import { createClient } from "@/lib/supabase/server";
import { updateProfile } from "../../../actions";

export default async function Settings({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: profile } = await supabase.from("profiles").select("display_name").eq("id", user!.id).single();
  const { data: ws } = await supabase.from("workspaces").select("id, name").eq("slug", slug).single();
  const { data: me } = await supabase.from("workspace_members").select("role").eq("workspace_id", ws!.id).eq("user_id", user!.id).single();
  return (
    <div className="max-w-md space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>
      <form action={updateProfile} className="card space-y-3">
        <input type="hidden" name="back" value={`/w/${slug}/settings`} />
        <label className="block text-sm font-medium">Your name
          <input className="input mt-1 font-normal" name="displayName" defaultValue={profile?.display_name ?? ""} maxLength={80} />
        </label>
        <p className="muted text-sm">Signed in as {user!.email}</p>
        <button className="btn">Save</button>
      </form>
      {can(me?.role as Role, "workspace.update") && <p className="muted text-sm">Workspace name and timezone editing arrives with the next milestone.</p>}
    </div>
  );
}
