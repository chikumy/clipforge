import { describe, expect, it } from "vitest";
import { assignableRoles, can, canChangeMemberRole, inviteSchema, parseEnv, ROLES, signUpSchema } from "./index";

describe("permissions", () => {
  it("matches the policy table", () => {
    expect(ROLES.filter((r) => can(r, "workspace.update"))).toEqual(["owner", "admin"]);
    expect(ROLES.filter((r) => can(r, "workspace.delete"))).toEqual(["owner"]);
    expect(ROLES.filter((r) => can(r, "members.invite"))).toEqual(["owner", "admin"]);
    expect(ROLES.every((r) => can(r, "members.view"))).toBe(true);
    expect(ROLES.filter((r) => can(r, "assets.upload"))).toEqual(["owner", "admin", "editor"]);
    expect(ROLES.every((r) => can(r, "assets.view"))).toBe(true);
    expect(can(null, "members.view")).toBe(false);
  });
  it("limits who can assign owner", () => {
    expect(assignableRoles("owner")).toContain("owner");
    expect(assignableRoles("admin")).not.toContain("owner");
    expect(assignableRoles("editor")).toEqual([]);
    expect(canChangeMemberRole("admin", "owner")).toBe(false);
    expect(canChangeMemberRole("admin", "editor")).toBe(true);
    expect(canChangeMemberRole("viewer", "viewer")).toBe(false);
  });
});

describe("schemas", () => {
  it("rejects owner invites and normalises email", () => {
    expect(inviteSchema.safeParse({ email: "A@B.co", role: "owner" }).success).toBe(false);
    expect(inviteSchema.parse({ email: " A@B.co ", role: "viewer" }).email).toBe("a@b.co");
  });
  it("enforces password length", () => {
    expect(signUpSchema.safeParse({ email: "a@b.co", password: "short", displayName: "A" }).success).toBe(false);
  });
});

describe("parseEnv", () => {
  const ok = { NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321", NEXT_PUBLIC_SUPABASE_ANON_KEY: "k", NEXT_PUBLIC_SITE_URL: "http://localhost:3000" };
  it("accepts a complete env", () => expect(parseEnv(ok).NEXT_PUBLIC_SITE_URL).toBe("http://localhost:3000"));
  it("names the bad variables without echoing values", () => {
    expect(() => parseEnv({ ...ok, NEXT_PUBLIC_SUPABASE_URL: "secret-not-a-url", NEXT_PUBLIC_SITE_URL: undefined })).toThrow(
      "Invalid or missing environment variables: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SITE_URL",
    );
    try { parseEnv({ ...ok, NEXT_PUBLIC_SUPABASE_URL: "secret-not-a-url" }); } catch (e) { expect((e as Error).message).not.toContain("secret-not-a-url"); }
  });
});
