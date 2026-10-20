import Link from "next/link";
import { ErrorNote, Field, Shell } from "@/lib/form";
import { safeNext } from "@/lib/safe-next";
import { signIn } from "../actions";

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string; next?: string }> }) {
  const q = await searchParams;
  return (
    <Shell title="Sign in">
      {q.notice && <p role="status" className="rounded-lg border border-[var(--line)] p-3 text-sm">{q.notice}</p>}
      <ErrorNote message={q.error} />
      <form action={signIn} className="space-y-4">
        <input type="hidden" name="next" value={safeNext(q.next)} />
        <Field label="Email" name="email" type="email" autoComplete="email" />
        <Field label="Password" name="password" type="password" autoComplete="current-password" />
        <button className="btn w-full">Sign in</button>
      </form>
      <p className="muted text-sm"><Link href="/forgot-password">Forgot password?</Link> · <Link href="/signup">Create account</Link></p>
    </Shell>
  );
}
