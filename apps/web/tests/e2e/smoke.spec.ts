import { expect, test } from "@playwright/test";

// Runs without Supabase: public pages and the signed-out gate.
test("landing page links to sign up and sign in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "ClipForge AI" })).toBeVisible();
  await page.getByRole("link", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/signup$/);
  await expect(page.getByLabel("Password (10+ characters)")).toBeVisible();
});

test("signed-out visitors are sent to login with the return path kept", async ({ page }) => {
  await page.goto("/w/acme/members");
  await expect(page).toHaveURL(/\/login\?next=%2Fw%2Facme%2Fmembers$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("invite links keep their token through login", async ({ page }) => {
  await page.goto("/invite/accept?token=abc");
  await expect(page).toHaveURL(/next=%2Finvite%2Faccept%3Ftoken%3Dabc/);
});

test("login ignores an off-site next parameter", async ({ page }) => {
  await page.goto("/login?next=//evil.example");
  await expect(page.locator('input[name="next"]')).toHaveValue("/onboarding");
});

test("security headers are set", async ({ request }) => {
  const r = await request.get("/");
  expect(r.headers()["x-frame-options"]).toBe("DENY");
  expect(r.headers()["x-content-type-options"]).toBe("nosniff");
});
