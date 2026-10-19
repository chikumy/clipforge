// Mirrors the RLS policies in supabase/migrations. The database is the enforcer;
// this matrix only decides what the UI offers and what server actions pre-check.
export const ROLES = ["owner", "admin", "editor", "approver", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const WORKSPACE_KINDS = ["creator", "business", "agency"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export type Permission =
  | "workspace.update"
  | "workspace.delete"
  | "members.invite"
  | "members.manage"
  | "members.view"
  | "audit.view";

const GRANTS: Record<Permission, readonly Role[]> = {
  "workspace.update": ["owner", "admin"],
  "workspace.delete": ["owner"],
  "members.invite": ["owner", "admin"],
  "members.manage": ["owner", "admin"],
  "members.view": ROLES,
  "audit.view": ["owner", "admin"],
};

export const can = (role: Role | null | undefined, permission: Permission): boolean =>
  !!role && GRANTS[permission].includes(role);

/** Roles `actor` may assign. Only owners can create owners; nobody is invited directly as owner. */
export const assignableRoles = (actor: Role): Role[] =>
  actor === "owner" ? [...ROLES] : actor === "admin" ? ROLES.filter((r) => r !== "owner") : [];

export const canChangeMemberRole = (actor: Role, target: Role): boolean =>
  can(actor, "members.manage") && (actor === "owner" || target !== "owner");
