import { assignableRoles, canChangeMemberRole, can, ROLES, type Role } from "@clipforge/shared";
import { ErrorNote } from "@/lib/form";
import { createClient } from "@/lib/supabase/server";
import { changeRole, inviteMember, removeMember, revokeInvitation } from "../../../actions";

type Member = { user_id: string; email: string; display_name: string | null; role: Role; joined_at: string };

export default async function Members({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string; invite?: string }> }) {
  const { slug } = await params;
  const q = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: ws } = await supabase.from("workspaces").select("id").eq("slug", slug).single();
  const { data } = await supabase.rpc("workspace_member_list", { p_workspace: ws!.id });
  const members = data as Member[] | null; // shortcut: hand-typed until generated DB types land
  const me = members?.find((m) => m.user_id === user!.id)?.role;
  const manage = can(me, "members.manage");
  const { data: invites } = manage
    ? await supabase.from("invitations").select("id, email, role, expires_at").is("accepted_at", null).eq("workspace_id", ws!.id)
    : { data: [] };
  const invite = inviteMember.bind(null, slug);
  // Only same-origin invite links are rendered back to the page.
  const inviteLink = q.invite && /^https?:\/\/[^\s]+\/invite\/accept\?token=[0-9a-f]{64}$/.test(q.invite) ? q.invite : null;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Members</h1>
      <ErrorNote message={q.error} />
      {inviteLink && (
        <div role="status" className="card text-sm">
          <p className="font-medium">Invitation created. Email delivery is not set up yet, so send this link to the person yourself. It works once, for that email address only.</p>
          <input readOnly className="input mt-2 font-mono text-xs" value={inviteLink} aria-label="Invitation link" />
        </div>
      )}
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Workspace members</caption>
        <thead className="muted"><tr><th scope="col" className="py-2">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {members?.map((m) => (
            <tr key={m.user_id} className="border-t border-[var(--line)]">
              <td className="py-2">{m.display_name ?? "—"}</td>
              <td>{m.email}</td>
              <td>
                {me && canChangeMemberRole(me, m.role) && m.user_id !== user!.id ? (
                  <form action={changeRole.bind(null, slug)} className="flex gap-2">
                    <input type="hidden" name="workspace" value={ws!.id} /><input type="hidden" name="user" value={m.user_id} />
                    <select name="role" defaultValue={m.role} className="input !w-auto !py-1" aria-label={`Role for ${m.email}`}>
                      {assignableRoles(me).map((r) => <option key={r}>{r}</option>)}
                    </select>
                    <button className="btn-ghost">Save</button>
                  </form>
                ) : m.role}
              </td>
              <td className="text-right">
                {(m.user_id === user!.id || (me && canChangeMemberRole(me, m.role))) && (
                  <form action={removeMember.bind(null, slug)}>
                    <input type="hidden" name="workspace" value={ws!.id} /><input type="hidden" name="user" value={m.user_id} />
                    <button className="btn-ghost">{m.user_id === user!.id ? "Leave" : "Remove"}</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {can(me, "members.invite") && (
        <section className="card space-y-3">
          <h2 className="font-semibold">Invite someone</h2>
          <form action={invite} className="flex flex-wrap items-end gap-3">
            <label className="text-sm font-medium">Email<input className="input mt-1 font-normal" name="email" type="email" required /></label>
            <label className="text-sm font-medium">Role
              <select className="input mt-1 font-normal" name="role" defaultValue="editor">
                {ROLES.filter((r) => r !== "owner" && assignableRoles(me!).includes(r)).map((r) => <option key={r}>{r}</option>)}
              </select>
            </label>
            <button className="btn">Create invitation</button>
          </form>
          {!!invites?.length && (
            <ul className="space-y-1 text-sm">
              {invites.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3">
                  <span>{i.email} · {i.role} · expires {new Date(i.expires_at).toLocaleDateString("en-GB")}</span>
                  <form action={revokeInvitation.bind(null, slug)}><input type="hidden" name="id" value={i.id} /><button className="btn-ghost">Revoke</button></form>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
