import { Shell } from "@/lib/form";
import { acceptInvitation } from "../../actions";

// Accepting is a POST so link prefetchers and mail scanners cannot consume the invitation.
export default async function Accept({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <Shell title="Join workspace">
      <p className="muted text-sm">You were invited to join a ClipForge workspace.</p>
      <form action={acceptInvitation}>
        <input type="hidden" name="token" value={token ?? ""} />
        <button className="btn w-full" disabled={!token}>Accept invitation</button>
      </form>
    </Shell>
  );
}
