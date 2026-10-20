import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it("keeps same-site paths", () => expect(safeNext("/w/acme/members?x=1")).toBe("/w/acme/members?x=1"));
  it.each(["//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)", "", null, 5])("rejects %s", (v) =>
    expect(safeNext(v)).toBe("/onboarding"));
});
