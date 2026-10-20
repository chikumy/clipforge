import { createClient } from "@/lib/supabase/server";

export default async function Dashboard({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: ws } = await supabase.from("workspaces").select("name, kind, timezone").eq("slug", slug).single();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{ws?.name}</h1>
      <p className="muted">{ws?.kind} workspace · timezone {ws?.timezone}</p>
      <section className="card">
        <h2 className="font-semibold">Nothing here yet</h2>
        <p className="muted mt-1 text-sm">Uploads, clips, brand kits and publishing arrive in the next milestones. For now you can invite your team on the Members page.</p>
      </section>
    </div>
  );
}
