import { redirect } from "next/navigation";
import { ErrorNote, Field, Shell } from "@/lib/form";
import { createClient } from "@/lib/supabase/server";
import { createWorkspace } from "../actions";

const KINDS = [
  ["creator", "Creator Studio", "Turn long videos into Shorts."],
  ["business", "Business Studio", "Branded marketing videos for one business."],
  ["agency", "Agency Studio", "Manage several clients with approvals."],
] as const;

export default async function Onboarding({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const q = await searchParams;
  const supabase = await createClient();
  const { data: workspaces } = await supabase.from("workspaces").select("name, slug").order("created_at");
  if (workspaces?.length && !q.error) redirect(`/w/${workspaces[0]!.slug}`);
  return (
    <Shell title="Create your workspace">
      <ErrorNote message={q.error} />
      <form action={createWorkspace} className="space-y-4">
        <Field label="Workspace name" name="name" />
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">What will you use it for?</legend>
          {KINDS.map(([value, title, hint], i) => (
            <label key={value} className="card flex cursor-pointer items-start gap-3 !p-3">
              <input type="radio" name="kind" value={value} defaultChecked={i === 0} className="mt-1" />
              <span><span className="font-medium">{title}</span><br /><span className="muted text-sm">{hint}</span></span>
            </label>
          ))}
        </fieldset>
        <button className="btn w-full">Create workspace</button>
      </form>
    </Shell>
  );
}
