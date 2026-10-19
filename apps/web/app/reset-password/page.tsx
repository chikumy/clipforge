import { ErrorNote, Field, Shell } from "@/lib/form";
import { updatePassword } from "../actions";

export default async function Reset({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const q = await searchParams;
  return (
    <Shell title="Choose a new password">
      <ErrorNote message={q.error} />
      <form action={updatePassword} className="space-y-4">
        <Field label="New password" name="password" type="password" autoComplete="new-password" />
        <button className="btn w-full">Update password</button>
      </form>
    </Shell>
  );
}
