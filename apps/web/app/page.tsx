import Link from "next/link";

export default function Landing() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-24 text-center">
      <h1 className="text-4xl font-bold sm:text-5xl">ClipForge AI</h1>
      <p className="muted mx-auto mt-4 max-w-xl text-lg">
        Turn long videos into Shorts, create branded videos from a brief, and manage clients in one workspace.
      </p>
      <p className="muted mt-2 text-sm">Early development: accounts and workspaces are available now; video tools are being built.</p>
      <div className="mt-8 flex justify-center gap-3">
        <Link className="btn" href="/signup">Create account</Link>
        <Link className="btn-ghost" href="/login">Sign in</Link>
      </div>
    </div>
  );
}
