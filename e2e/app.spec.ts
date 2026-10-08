import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { APP_PASSWORD } from '../playwright.config';

const seed: { type: string }[] = JSON.parse(readFileSync(new URL('../lib/collection.json', import.meta.url), 'utf8'));
const seedStandalone = seed.filter(game => game.type === 'standalone').length;
const seedExpansions = seed.length - seedStandalone;

async function signIn(page: Page)
{
    await page.goto('/login');
    await page.getByLabel('Password').fill(APP_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('galeswift’s collection')).toBeVisible();
}

async function openProfile(page: Page, name: string)
{
    await page.getByRole('combobox', { name: 'Whose collection' }).click();
    await page.getByRole('option', { name: 'Another BGG user…' }).click();
    await page.getByLabel('BGG username').fill(name);
    await page.getByRole('button', { name: 'Open' }).click();
}

// Box art comes from BGG's CDN; tests never reach out to it.
test.beforeEach(async ({ page }) =>
{
    await page.route('https://cf.geekdo-images.com/**', route => route.abort());
});

const uniqueProfile = (prefix: string) => `${prefix}-${Date.now().toString(36)}`;

test('the collection is behind the password', async ({ page }) =>
{
    // Signed-out visitors land on the front page.
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('button', { name: 'Try the demo' })).toBeVisible();

    await page.getByLabel('Password').fill('wrong password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('That password didn’t match.')).toBeVisible();

    await page.getByLabel('Password').fill(APP_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\?profile=galeswift$/);
    await expect(page.getByText(`${seedStandalone} games · ${seedExpansions} expansions reviewed separately`)).toBeVisible();
});

test('the demo shows the sample collection without saving anything', async ({ page }) =>
{
    await page.goto('/login');
    await page.getByRole('button', { name: 'Try the demo' }).click();

    await expect(page.getByText('Sample collection', { exact: true })).toBeVisible();
    await expect(page.getByRole('note')).toContainText('nothing is saved');
    await expect(page.getByText(`${seedStandalone} games · ${seedExpansions} expansions reviewed separately`)).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Whose collection' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sync from BGG' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0);
    // Each row shows its box art faded in behind the title.
    await expect(page.locator('.game-row .row-art').first()).toHaveAttribute('style', /cf\.geekdo-images\.com/);

    // Changes work on the page but stay there.
    await page.locator('#target').fill(String(seedStandalone - 5));
    await expect(page.getByRole('tab', { name: 'Cull list 5' })).toBeVisible();
    await expect(page.getByText('Demo: changes aren’t saved')).toBeVisible();

    await page.getByRole('tab', { name: /Cull list/ }).click();
    await expect(page.getByRole('button', { name: /(Check|Refresh) prices/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Sell on eBay' }).click();
    const panel = page.getByRole('dialog');

    await panel.getByRole('checkbox').first().click();
    await panel.getByRole('button', { name: 'Write descriptions (1)' }).click();
    await expect(panel.getByText('Template', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText('The demo uses the built-in description template.')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.reload();
    await expect(page.locator('#target')).toHaveValue('192');

    // The owner's sign-in is one click away.
    await page.getByRole('note').getByRole('link', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/login$/);
});

test('a big import runs in the background and survives a reload', async ({ page }) =>
{
    await signIn(page);
    await page.goto('/?profile=bigshelf');
    await page.getByRole('button', { name: 'Import from BoardGameGeek' }).click();

    const progress = page.locator('.sync-progress');

    await expect(progress).toContainText('Importing from BoardGameGeek… 0 of 45 games', { timeout: 15_000 });

    // Leaving and coming back picks the running import up again.
    await page.reload();
    await expect(progress).toContainText(/Importing from BoardGameGeek… \d+ of 45 games/, { timeout: 15_000 });
    await expect(progress.getByRole('progressbar', { name: 'BGG import progress' })).toBeVisible();
    await expect(page.getByText('Imported 45 entries from BoardGameGeek')).toBeVisible({ timeout: 30_000 });
    await expect(progress).toHaveCount(0);
    await expect(page.getByText('45 games · 0 expansions reviewed separately')).toBeVisible();
});

test("a friend's BGG collection imports into its own profile", async ({ page }) =>
{
    const friend = uniqueProfile('friend');

    await signIn(page);

    await openProfile(page, friend);
    await expect(page).toHaveURL(new RegExp(`\\?profile=${friend}$`));
    await expect(page.getByRole('heading', { name: `No collection for ${friend} yet` })).toBeVisible();

    await page.getByRole('button', { name: 'Import from BoardGameGeek' }).click();
    await expect(page.getByText('Imported 3 entries from BoardGameGeek')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('2 games · 1 expansions reviewed separately')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Fixture Quest', exact: true })).toHaveAttribute(
        'href',
        'https://boardgamegeek.com/boardgame/900001'
    );

    // The pencil opens the details panel; the name links to BGG.
    await page.getByRole('button', { name: 'Edit details for Fixture Quest' }).click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Fixture Quest' })).toBeVisible();
    await page.keyboard.press('Escape');

    // Preferences save and survive a reload.
    const keep = page.getByRole('button', { name: 'Prefer keep Fixture Quest' });

    await keep.click();
    await expect(keep).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Prefer keep Fixture Quest' })).toHaveAttribute('aria-pressed', 'true');

    // Switching back shows the default collection, untouched.
    await page.getByRole('combobox', { name: 'Whose collection' }).click();
    await page.getByRole('option', { name: 'galeswift' }).click();
    await expect(page.getByText('galeswift’s collection')).toBeVisible();
    await expect(page.getByText(`${seedStandalone} games · ${seedExpansions} expansions reviewed separately`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Prefer keep Fixture Quest' })).toHaveCount(0);

    // The friend's profile is now offered in the picker.
    await page.getByRole('combobox', { name: 'Whose collection' }).click();
    await expect(page.getByRole('option', { name: friend })).toBeVisible();
});

test('re-syncing keeps choices made on the previous import', async ({ page }) =>
{
    const friend = uniqueProfile('resync');

    await signIn(page);
    await page.goto(`/?profile=${friend}`);
    await page.getByRole('button', { name: 'Import from BoardGameGeek' }).click();
    await expect(page.getByText('Imported 3 entries')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Prefer cull Test Tiles' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible();

    await page.getByRole('button', { name: 'Sync from BGG' }).click();
    await expect(page.getByText('Imported 3 entries')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Prefer cull Test Tiles' })).toHaveAttribute('aria-pressed', 'true');
});

test('an unknown BGG username shows a clear error', async ({ page }) =>
{
    await signIn(page);
    await page.goto('/?profile=nobody');
    await page.getByRole('button', { name: 'Import from BoardGameGeek' }).click();
    await expect(page.getByText('BoardGameGeek doesn’t recognise that username.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'No collection for nobody yet' })).toBeVisible();
});

test('cull reasons show as icons with details on hover', async ({ page }) =>
{
    const friend = uniqueProfile('icons');

    await signIn(page);
    await page.goto(`/?profile=${friend}`);
    await page.getByRole('button', { name: 'Import from BoardGameGeek' }).click();
    await expect(page.getByText('Imported 3 entries')).toBeVisible({ timeout: 30_000 });

    await page.locator('#target').fill('1');
    await page.getByRole('tab', { name: /Cull list/ }).click();
    const row = page.locator('article', { hasText: 'Test Tiles' });

    await expect(row.getByRole('button', { name: /^Rating 6\.4\/10/ })).toHaveText('6.4');
    await expect(row.getByRole('button', { name: /^Below your rating threshold/ })).toHaveText('−9.0');

    await row.getByRole('button', { name: /^Below your rating threshold/ }).hover();
    await expect(page.getByRole('tooltip')).toContainText('6.4/10 is 0.6 below your 7.0 threshold.');

    // The reason is also spelled out in words, without hovering.
    await expect(row.locator('.cull-reason')).toHaveText(/rate it 6\.4, below your 7\.0 bar\./);
});

test('the cull list says how much play-experience coverage survives', async ({ page }) =>
{
    await page.goto('/login');
    await page.getByRole('button', { name: 'Try the demo' }).click();
    await page.getByRole('tab', { name: /Cull list/ }).click();

    const summary = page.getByRole('region', { name: 'Play-experience coverage' });

    await expect(summary).toContainText(/Letting go of these 100 games keeps \d+% of your play experiences/);
    await summary.getByRole('button', { name: 'See coverage' }).click();

    await expect(page.getByRole('heading', { name: 'What your collection covers' })).toBeVisible();
    await expect(page.getByRole('img', { name: /^Heavy strategy: keeping \d+ of \d+$/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Play groups with nothing left' })).toBeVisible();

    // Keeping everything leaves every play group covered.
    await page.locator('#target').fill(String(seedStandalone));
    await expect(page.getByRole('heading', { name: 'Play groups with nothing left' })).toHaveCount(0);
});

test("the cull list exports to Noble Knight's trade-in template", async ({ page }) =>
{
    const friend = uniqueProfile('trade');

    await signIn(page);
    await page.goto(`/?profile=${friend}`);
    await page.getByRole('button', { name: 'Import from BoardGameGeek' }).click();
    await expect(page.getByText('Imported 3 entries')).toBeVisible({ timeout: 30_000 });
    await page.locator('#target').fill('1');
    await page.getByRole('tab', { name: /Cull list/ }).click();

    const condition = page.getByRole('combobox', { name: 'Trade-in condition for Test Tiles' });

    await expect(condition).toHaveText('Used');
    await condition.click();
    await page.getByRole('option', { name: 'Unpunched' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible();

    const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: 'Noble Knight trade-in' }).click(),
    ]);

    expect(download.suggestedFilename()).toBe(`noble-knight-trade-in-${friend}.xlsx`);
    const { readFile } = await import('node:fs/promises');
    const { strFromU8, unzipSync } = await import('fflate');
    const sheet = strFromU8(unzipSync(new Uint8Array(await readFile(await download.path())))['xl/worksheets/sheet1.xml']);

    expect(sheet).toContain('>Tile Co.<');
    expect(sheet).toContain('>Test Tiles<');
    expect(sheet).toContain('>Unpunched<');
    expect(sheet).not.toContain('>Fixture Quest<');
});

test('the cull list shows estimated used and new values', async ({ page }) =>
{
    const friend = uniqueProfile('value');

    await signIn(page);
    await page.goto(`/?profile=${friend}`);
    await page.getByRole('button', { name: 'Import from BoardGameGeek' }).click();
    await expect(page.getByText('Imported 3 entries')).toBeVisible({ timeout: 30_000 });
    await page.locator('#target').fill('1');
    await page.getByRole('tab', { name: /Cull list/ }).click();

    await page.getByRole('button', { name: 'Check prices' }).click();
    await expect(page.getByText('Prices updated for 1 game from BGG GeekMarket, BoardGamePrices.com')).toBeVisible({ timeout: 30_000 });
    const row = page.locator('article', { hasText: 'Test Tiles' });

    await expect(row.getByRole('button', { name: /^Used value \$25\./ })).toBeVisible();
    // New: the three in-stock store prices outweigh a single GeekMarket listing.
    await expect(row.getByRole('button', { name: /^New value \$42\./ })).toBeVisible();
    // Each price's label carries its full source breakdown.
    await expect(row.getByRole('button', { name: /^Used value/ })).toHaveAccessibleName(
        /BGG GeekMarket: \$25 median of 3 listings \(\$20–\$30\).*Shipping is not included\./
    );
    await expect(row.getByRole('button', { name: /^New value/ })).toHaveAccessibleName(
        /BoardGamePrices\.com: \$42 median of 3 store prices \(\$40–\$44\), shipping ~\$6.*Shipping is extra: typically ~\$6\./
    );
    await row.getByRole('button', { name: /^New value/ }).hover();
    await expect(page.getByRole('tooltip')).toContainText('New ≈ $42 + ~$6 shipping');
    await expect(page.getByRole('link', { name: 'BoardGamePrices.com' })).toHaveAttribute('href', 'https://boardgameprices.com');

    // Cached prices load on their own next time.
    await page.reload();
    await page.getByRole('tab', { name: /Cull list/ }).click();
    await expect(page.locator('article', { hasText: 'Test Tiles' }).getByRole('button', { name: /^Used value \$25\./ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh prices' })).toBeVisible();
});

test('selected cull games become an eBay drafts upload file', async ({ page }) =>
{
    const friend = uniqueProfile('ebay');

    await signIn(page);
    await page.goto(`/?profile=${friend}`);
    await page.getByRole('button', { name: 'Import from BoardGameGeek' }).click();
    await expect(page.getByText('Imported 3 entries')).toBeVisible({ timeout: 30_000 });
    await page.locator('#target').fill('1');
    await page.getByRole('tab', { name: /Cull list/ }).click();
    await page.getByRole('button', { name: /(Check|Refresh) prices/ }).click();
    await expect(page.getByText(/^Prices updated for/)).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Sell on eBay' }).click();
    const panel = page.getByRole('dialog');

    await panel.getByRole('checkbox', { name: 'Sell Test Tiles' }).click();
    await panel.getByRole('button', { name: 'Write descriptions (1)' }).click();
    await expect(panel.getByText('Template', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText('Descriptions use the built-in template')).toBeVisible();

    const description = panel.getByRole('textbox', { name: 'Description' });

    await expect(description).toHaveValue(
        /^Test Tiles \(2021\) is a medium-light board game for 2–4 players that plays in about 30 minutes\. Lay tiles to build patterns\./
    );
    await expect(panel.getByRole('textbox', { name: /^Title/ })).toHaveValue('Test Tiles Board Game - Tile Co.');
    await panel.getByRole('textbox', { name: 'Condition notes for buyers' }).fill('All tiles present.');

    // Suggested price: 10% under the market estimate for the copy's condition.
    const price = panel.getByRole('spinbutton', { name: 'Price (USD)' });

    await expect(price).toHaveValue('22.50');
    await expect(panel.getByText('Suggested $22.50: 10% under the $25.00 used market estimate.')).toBeVisible();
    await panel.getByRole('combobox', { name: 'eBay condition for Test Tiles' }).click();
    await page.getByRole('option', { name: 'New', exact: true }).click();
    await expect(price).toHaveValue('37.80');
    await expect(panel.getByText('Suggested $37.80: 10% under the $42.00 new market estimate.')).toBeVisible();
    // A price the seller typed is kept when the condition changes.
    await price.fill('27');
    await panel.getByRole('combobox', { name: 'eBay condition for Test Tiles' }).click();
    await page.getByRole('option', { name: 'Used', exact: true }).click();
    await expect(price).toHaveValue('27');

    const [download] = await Promise.all([
        page.waitForEvent('download'),
        panel.getByRole('button', { name: 'Download eBay drafts (1)' }).click(),
    ]);

    expect(download.suggestedFilename()).toBe(`ebay-drafts-${friend}.csv`);
    const { readFile } = await import('node:fs/promises');
    const lines = (await readFile(await download.path(), 'utf8')).split('\r\n');

    expect(lines[1]).toMatch(/^Action\(SiteID=US/);
    expect(lines[2]).toMatch(/^Draft,BGG-900002,180349,Test Tiles Board Game - Tile Co\.,,27\.00,1,,3000,"?<h2>Test Tiles<\/h2>/);
    expect(lines[2]).toContain('<p>All tiles present.</p>');
    await expect(panel.getByText('Upload it in eBay Seller Hub')).toBeVisible();
});

test('checking prices shows progress batch by batch', async ({ page }) =>
{
    await signIn(page);
    // Keep all but 12 of the bundled collection: two batches of price lookups.
    await page.locator('#target').fill(String(seedStandalone - 12));
    await page.getByRole('tab', { name: /Cull list/ }).click();
    await page.getByRole('button', { name: /(Check|Refresh) prices/ }).click();

    const progress = page.locator('.price-progress');

    await expect(progress).toContainText('Checking prices… 0 of 12 games');
    await expect(progress.getByRole('progressbar', { name: 'Price check progress' })).toBeVisible();
    await expect(progress).toContainText('Checking prices… 10 of 12 games', { timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Checking 10/12…' })).toBeDisabled();
    await expect(page.getByText(/^Prices updated for 12 games from /)).toBeVisible({ timeout: 30_000 });
    await expect(progress).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Refresh prices' })).toBeEnabled();
});

test('All Games sorts by column, and collections can be removed', async ({ page }) =>
{
    await signIn(page);
    await expect(page.getByRole('tab', { name: 'All Games' })).toHaveAttribute('aria-selected', 'true');
    const ratings = async () => (await page.locator('article.game-row .rating-value strong').allInnerTexts()).slice(0, 8).map(Number);

    // Click the Rating header: highest first. Click again: lowest first.
    const header = page.getByRole('columnheader', { name: 'Sort by Rating' });

    await page.getByRole('button', { name: 'Sort by Rating' }).click();
    await expect(header).toHaveAttribute('aria-sort', 'descending');
    await expect(page.getByText('Sorted by rating, highest first')).toBeVisible();
    const desc = await ratings();

    expect(desc).toEqual([...desc].sort((a, b) => b - a));
    await page.getByRole('button', { name: 'Sort by Rating' }).click();
    await expect(header).toHaveAttribute('aria-sort', 'ascending');
    const asc = await ratings();

    expect(asc).toEqual([...asc].sort((a, b) => a - b));

    // The toolbar menu offers columns that have no header, like play time.
    await page.getByRole('combobox', { name: 'Sort games by' }).click();
    await page.getByRole('option', { name: 'Sort: Play time' }).click();
    await expect(page.getByText('Sorted by play time, shortest first')).toBeVisible();

    // Remove a test collection.
    const friend = uniqueProfile('remove');

    await openProfile(page, friend);
    await page.getByRole('button', { name: 'Import from BoardGameGeek' }).click();
    await expect(page.getByText('Imported 3 entries')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('combobox', { name: 'Whose collection' }).click();
    await page.getByRole('option', { name: `Remove ${friend}’s collection…` }).click();
    const dialog = page.getByRole('alertdialog');

    await expect(dialog).toContainText(`Remove ${friend}’s collection?`);
    await dialog.getByRole('button', { name: 'Remove collection' }).click();
    await expect(page.getByText(`Removed ${friend}’s collection.`)).toBeVisible();
    await expect(page.getByText('galeswift’s collection', { exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Whose collection' }).click();
    await expect(page.getByRole('option', { name: friend, exact: true })).toHaveCount(0);
    // The default collection can't be removed.
    await expect(page.getByRole('option', { name: /^Remove / })).toHaveCount(0);
});
