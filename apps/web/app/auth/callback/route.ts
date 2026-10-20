import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { safeNext } from "@/lib/safe-next";
import { createClient } from "@/lib/supabase/server";

// Email confirmation / recovery links land here with a one-time PKCE code.
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const next = safeNext(request.nextUrl.searchParams.get("next"));
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, env.NEXT_PUBLIC_SITE_URL));
  }
  return NextResponse.redirect(new URL("/login?error=" + encodeURIComponent("That link is invalid or has expired."), env.NEXT_PUBLIC_SITE_URL));
}
