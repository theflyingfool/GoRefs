import { test, expect } from "@playwright/test";

// Bulbasaur is used elsewhere in this suite (log-catch-iv-entry.spec.ts) as a
// safe, deterministic species for a fresh browser context.
test("edit-instance: Collection's action menu edits a logged specimen's nickname and Dynamax flag", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });

  await page.goto("/#/log-catch");
  await page.waitForLoadState("networkidle");

  await page.getByRole("searchbox").fill("bulbasaur");
  await page.getByText("Bulbasaur", { exact: false }).first().click();

  // The "Full details" mode toggle is a plain <button>, not an ARIA tab.
  await page.getByRole("button", { name: "Full details" }).click();

  await page.getByLabel("Nickname").fill("Bulby");

  await page.getByRole("button", { name: /^save$/i }).click();
  await page.waitForTimeout(500);

  await page.goto("/#/collection");
  await page.waitForLoadState("networkidle");

  const row = page.locator(".collection-row", { hasText: "Bulby" }).first();
  await expect(row).toBeVisible();
  await row.locator(".collection-row-main").click();
  await row.getByRole("button", { name: "Edit details" }).click();

  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Bulbasaur", { exact: false }).first()).toBeVisible();
  const nicknameInput = page.getByLabel("Nickname");
  await expect(nicknameInput).toHaveValue("Bulby");

  await nicknameInput.fill("Bulby Renamed");
  await page.getByRole("checkbox", { name: "Dynamax" }).check();

  await page.getByRole("button", { name: /^save$/i }).click();
  await page.waitForTimeout(500);

  await page.goto("/#/collection");
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Bulby Renamed", { exact: false })).toBeVisible();
});

test("edit-instance: a stale/nonexistent instance id redirects to Collection without crashing", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  await page.goto("/#/collection/999999/edit");
  await page.waitForLoadState("networkidle");

  await expect(page).toHaveURL(/#\/collection$/);
  expect(consoleErrors).toEqual([]);
});
