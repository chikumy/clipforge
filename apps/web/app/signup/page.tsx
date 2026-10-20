import Link from "next/link";
import { ErrorNote, Field, Shell } from "@/lib/form";
import { signUp } from "../actions";

export default async function SignUp({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const q = await searchParams;
  return (
    <Shell title="Create your account">
      <ErrorNote message={q.error} />
      <form action={signUp} className="space-y-4">
        <Field label="Your name" name="displayName" autoComplete="name" />
        <Field label="Email" name="email" type="email" autoComplete="email" />
        <Field label="Password (10+ characters)" name="password" type="password" autoComplete="new-password" />
        <button className="btn w-full">Create account</button>
      </form>
      <p className="muted text-sm">Already registered? <Link href="/login">Sign in</Link></p>
    </Shell>
  );
}
