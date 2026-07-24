import { test, expect, type Page, type Locator } from "@playwright/test";

// TagsPage's rename input has no accessible name/placeholder (it's a bare
// always-editable text input, see TagsPage.vue) and v-model doesn't reflect
// into the `value` attribute, so neither getByRole(name:) nor a CSS
// attribute selector can find a row by its tag name -- read each row's
// live input value instead.
async function findTagRow(page: Page, tagName: string): Promise<Locator | undefined> {
  const rows = page.locator(".collection-row");
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    const value = await rows.nth(i).locator("input[type='text']").inputValue();
    if (value === tagName) return rows.nth(i);
  }
  return undefined;
}

// Bulbasaur is used elsewhere in this suite (log-catch-iv-entry.spec.ts,
// edit-instance.spec.ts) as a safe, deterministic species for a fresh
// browser context.
test("tags-page: create a tag while logging a catch, then rename and delete it from the Tags page", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });

  await page.goto("/#/log-catch");
  await page.waitForLoadState("networkidle");

  await page.getByRole("searchbox").fill("bulbasaur");
  await page.getByText("Bulbasaur", { exact: false }).first().click();

  // The "Full details" mode toggle is a plain <button>, not an ARIA tab.
  await page.getByRole("button", { name: "Full details" }).click();

  const tagName = `E2E Tag ${Date.now()}`;
  await page.getByPlaceholder("New tag…").fill(tagName);
  await page.getByRole("button", { name: "+ Add tag" }).click();

  // addNewTag() auto-selects the freshly created tag, so no extra chip
  // click is needed before saving.
  await page.getByRole("button", { name: /^save$/i }).click();
  await page.waitForTimeout(500);

  await page.goto("/#/tags");
  await page.waitForLoadState("networkidle");

  const row = await findTagRow(page, tagName);
  expect(row, `expected a tag row for "${tagName}"`).toBeDefined();
  await expect(row!.getByText("1 specimen", { exact: false })).toBeVisible();

  const renamedName = `${tagName} Renamed`;
  const nameInput = row!.locator("input[type='text']");
  await nameInput.fill(renamedName);
  await nameInput.dispatchEvent("change");
  await page.waitForTimeout(300);

  await page.reload();
  await page.waitForLoadState("networkidle");

  const renamedRow = await findTagRow(page, renamedName);
  expect(renamedRow, `expected a tag row for "${renamedName}" after reload`).toBeDefined();
  expect(await findTagRow(page, tagName), "old tag name should no longer exist after rename").toBeUndefined();

  page.once("dialog", (dialog) => dialog.accept());
  await renamedRow!.getByRole("button", { name: "Delete" }).click();
  await page.waitForTimeout(300);

  expect(await findTagRow(page, renamedName), "tag row should be gone after delete").toBeUndefined();
});

// Creates a tag via Log a catch's inline tag creator (same mechanism as the
// test above) and logs a catch for it, so a fresh, deterministic tag exists
// to rename in the Tags page test below.
async function createTagViaLogCatch(page: Page, tagName: string): Promise<void> {
  await page.goto("/#/log-catch");
  await page.waitForLoadState("networkidle");

  // Species selection is skipped if a species is already selected from a
  // prior catch logged earlier in the same test (the page retains it).
  const searchbox = page.getByRole("searchbox");
  if (await searchbox.isVisible().catch(() => false)) {
    await searchbox.fill("bulbasaur");
    await page.getByText("Bulbasaur", { exact: false }).first().click();
  }

  await page.getByRole("button", { name: "Full details" }).click();

  await page.getByPlaceholder("New tag…").fill(tagName);
  await page.getByRole("button", { name: "+ Add tag" }).click();

  await page.getByRole("button", { name: /^save$/i }).click();
  await page.waitForTimeout(500);
}

test("tags-page: renaming a tag to a name that already exists shows an inline error and does not persist", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });

  const nameA = `E2E Collide A ${Date.now()}`;
  const nameB = `E2E Collide B ${Date.now()}`;

  await createTagViaLogCatch(page, nameA);
  await createTagViaLogCatch(page, nameB);

  await page.goto("/#/tags");
  await page.waitForLoadState("networkidle");

  const rowB = await findTagRow(page, nameB);
  expect(rowB, `expected a tag row for "${nameB}"`).toBeDefined();

  const nameInput = rowB!.locator("input[type='text']");
  await nameInput.fill(nameA);
  await nameInput.dispatchEvent("change");
  await page.waitForTimeout(300);

  await expect(rowB!.getByText(`A tag named "${nameA}" already exists.`)).toBeVisible();

  await page.reload();
  await page.waitForLoadState("networkidle");

  // The rejected rename must never have reached the DB: "B" is still "B",
  // and "A" is still present and untouched (no silent overwrite/loss).
  expect(await findTagRow(page, nameB), `expected "${nameB}" to still exist after reload`).toBeDefined();
  expect(await findTagRow(page, nameA), `expected "${nameA}" to still exist unchanged after reload`).toBeDefined();
});
