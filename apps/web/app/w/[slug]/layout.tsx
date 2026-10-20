import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "../../actions";

export default async function WorkspaceLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  // RLS returns only workspaces the user belongs to, so a foreign slug is simply "not found".
  const { data: all } = await supabase.from("workspaces").select("name, slug").order("created_at");
  const current = all?.find((w) => w.slug === slug);
  if (!current) notFound();
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] pb-4">
        <nav aria-label="Workspace" className="flex flex-wrap items-center gap-4">
          <strong>ClipForge</strong>
          <Link href={`/w/${slug}`}>Dashboard</Link>
          <Link href={`/w/${slug}/members`}>Members</Link>
          <Link href={`/w/${slug}/settings`}>Settings</Link>
        </nav>
        <div className="flex items-center gap-3">
          {all && all.length > 1 ? (
            <ul className="flex gap-2 text-sm">{all.map((w) => <li key={w.slug}><Link aria-current={w.slug === slug ? "page" : undefined} className={w.slug === slug ? "font-bold" : "muted"} href={`/w/${w.slug}`}>{w.name}</Link></li>)}</ul>
          ) : <span className="muted text-sm">{current.name}</span>}
          <form action={signOut}><button className="btn-ghost text-sm">Sign out</button></form>
        </div>
      </header>
      <div className="py-8">{children}</div>
    </div>
  );
}
