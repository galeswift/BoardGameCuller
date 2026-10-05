import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { APP_PASSWORD } from "../playwright.config";

const seed: { type: string }[] = JSON.parse(readFileSync(new URL("../lib/collection.json", import.meta.url), "utf8"));
const seedStandalone = seed.filter((g) => g.type === "standalone").length;
const seedExpansions = seed.length - seedStandalone;

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Password").fill(APP_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("galeswift’s collection")).toBeVisible();
}

async function openProfile(page: Page, name: string) {
  await page.getByRole("combobox", { name: "Whose collection" }).click();
  await page.getByRole("option", { name: "Another BGG user…" }).click();
  await page.getByLabel("BGG username").fill(name);
  await page.getByRole("button", { name: "Open" }).click();
}

const uniqueProfile = (prefix: string) => `${prefix}-${Date.now().toString(36)}`;

test("the collection is behind the password", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Couldn’t load your collection" })).toBeVisible();
  await page.getByRole("link", { name: "Sign in" }).click();

  await page.getByLabel("Password").fill("wrong password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("That password didn’t match.")).toBeVisible();

  await page.getByLabel("Password").fill(APP_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\?profile=galeswift$/);
  await expect(page.getByText(`${seedStandalone} games · ${seedExpansions} expansions reviewed separately`)).toBeVisible();
});

test("a friend's BGG collection imports into its own profile", async ({ page }) => {
  const friend = uniqueProfile("friend");
  await signIn(page);

  await openProfile(page, friend);
  await expect(page).toHaveURL(new RegExp(`\\?profile=${friend}$`));
  await expect(page.getByRole("heading", { name: `No collection for ${friend} yet` })).toBeVisible();

  await page.getByRole("button", { name: "Import from BoardGameGeek" }).click();
  await expect(page.getByText("Imported 3 entries from BoardGameGeek")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("2 games · 1 expansions reviewed separately")).toBeVisible();
  await expect(page.getByRole("link", { name: "Fixture Quest", exact: true })).toHaveAttribute("href", "https://boardgamegeek.com/boardgame/900001");

  // The pencil opens the details panel; the name links to BGG.
  await page.getByRole("button", { name: "Edit details for Fixture Quest" }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Fixture Quest" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Preferences save and survive a reload.
  const keep = page.getByRole("button", { name: "Prefer keep Fixture Quest" });
  await keep.click();
  await expect(keep).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("status").filter({ hasText: "All changes saved" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Prefer keep Fixture Quest" })).toHaveAttribute("aria-pressed", "true");

  // Switching back shows the default collection, untouched.
  await page.getByRole("combobox", { name: "Whose collection" }).click();
  await page.getByRole("option", { name: "galeswift" }).click();
  await expect(page.getByText("galeswift’s collection")).toBeVisible();
  await expect(page.getByText(`${seedStandalone} games · ${seedExpansions} expansions reviewed separately`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Prefer keep Fixture Quest" })).toHaveCount(0);

  // The friend's profile is now offered in the picker.
  await page.getByRole("combobox", { name: "Whose collection" }).click();
  await expect(page.getByRole("option", { name: friend })).toBeVisible();
});

test("re-syncing keeps choices made on the previous import", async ({ page }) => {
  const friend = uniqueProfile("resync");
  await signIn(page);
  await page.goto(`/?profile=${friend}`);
  await page.getByRole("button", { name: "Import from BoardGameGeek" }).click();
  await expect(page.getByText("Imported 3 entries")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Prefer cull Test Tiles" }).click();
  await expect(page.getByRole("status").filter({ hasText: "All changes saved" })).toBeVisible();

  await page.getByRole("button", { name: "Sync from BGG" }).click();
  await expect(page.getByText("Imported 3 entries")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Prefer cull Test Tiles" })).toHaveAttribute("aria-pressed", "true");
});

test("an unknown BGG username shows a clear error", async ({ page }) => {
  await signIn(page);
  await page.goto("/?profile=nobody");
  await page.getByRole("button", { name: "Import from BoardGameGeek" }).click();
  await expect(page.getByText("BoardGameGeek doesn’t recognise that username.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "No collection for nobody yet" })).toBeVisible();
});

test("cull reasons show as icons with details on hover", async ({ page }) => {
  const friend = uniqueProfile("icons");
  await signIn(page);
  await page.goto(`/?profile=${friend}`);
  await page.getByRole("button", { name: "Import from BoardGameGeek" }).click();
  await expect(page.getByText("Imported 3 entries")).toBeVisible({ timeout: 30_000 });

  await page.locator("#target").fill("1");
  await page.getByRole("tab", { name: /Cull list/ }).click();
  const row = page.locator("article", { hasText: "Test Tiles" });
  await expect(row.getByRole("button", { name: /^Rating 6\.4\/10/ })).toHaveText("6.4");
  await expect(row.getByRole("button", { name: /^Below your rating threshold/ })).toHaveText("−9.0");

  await row.getByRole("button", { name: /^Below your rating threshold/ }).hover();
  await expect(page.getByRole("tooltip")).toContainText("6.4/10 is 0.6 below your 7.0 threshold.");
});

test("the cull list exports to Noble Knight's trade-in template", async ({ page }) => {
  const friend = uniqueProfile("trade");
  await signIn(page);
  await page.goto(`/?profile=${friend}`);
  await page.getByRole("button", { name: "Import from BoardGameGeek" }).click();
  await expect(page.getByText("Imported 3 entries")).toBeVisible({ timeout: 30_000 });
  await page.locator("#target").fill("1");
  await page.getByRole("tab", { name: /Cull list/ }).click();

  const condition = page.getByRole("combobox", { name: "Trade-in condition for Test Tiles" });
  await expect(condition).toHaveText("Used");
  await condition.click();
  await page.getByRole("option", { name: "Unpunched" }).click();
  await expect(page.getByRole("status").filter({ hasText: "All changes saved" })).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Noble Knight trade-in" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`noble-knight-trade-in-${friend}.xlsx`);
  const { readFile } = await import("node:fs/promises");
  const { strFromU8, unzipSync } = await import("fflate");
  const sheet = strFromU8(unzipSync(new Uint8Array(await readFile(await download.path())))["xl/worksheets/sheet1.xml"]);
  expect(sheet).toContain(">Tile Co.<");
  expect(sheet).toContain(">Test Tiles<");
  expect(sheet).toContain(">Unpunched<");
  expect(sheet).not.toContain(">Fixture Quest<");
});
