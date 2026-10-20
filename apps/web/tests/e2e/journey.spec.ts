import { expect, test } from "@playwright/test";

// Full journey against a real local Supabase (`supabase start`, email confirmations off).
// Skipped unless E2E_FULL=1; CI sets it.
test.skip(!process.env.E2E_FULL, "needs a running local Supabase stack");

const password = "correct horse battery";
const stamp = Date.now();
const owner = `owner${stamp}@example.com`;
const guest = `guest${stamp}@example.com`;

async function signUpAndIn(page: import("@playwright/test").Page, email: string, name: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password (10+ characters)").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/login\?notice=/); // let the sign-up action finish before navigating away
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/onboarding/); // session cookie is set once this lands
}

test("owner creates a workspace, invites a guest, and the guest sees only that workspace", async ({ page, browser }) => {
  await signUpAndIn(page, owner, "Olive Owner");
  await page.getByLabel("Workspace name").fill("Acme Studio");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByRole("heading", { name: "Acme Studio" })).toBeVisible();

  await page.getByRole("link", { name: "Members" }).click();
  await page.getByLabel("Email").fill(guest);
  await page.getByRole("button", { name: "Create invitation" }).click();
  const link = await page.getByLabel("Invitation link").inputValue();

  const ctx = await browser.newContext();
  const guestPage = await ctx.newPage();
  await signUpAndIn(guestPage, guest, "Gus Guest");
  await guestPage.goto(link);
  await expect(guestPage.getByRole("heading", { name: "Join workspace" })).toBeVisible();
  await guestPage.getByRole("button", { name: "Accept invitation" }).click();
  await expect(guestPage.getByRole("heading", { name: "Acme Studio" })).toBeVisible();

  // The guest cannot manage members and cannot open an unrelated workspace.
  await guestPage.getByRole("link", { name: "Members" }).click();
  await expect(guestPage.getByRole("button", { name: "Create invitation" })).toHaveCount(0);
  const resp = await guestPage.goto("/w/does-not-exist/members");
  expect(resp?.status()).toBe(404);
  await ctx.close();
});
