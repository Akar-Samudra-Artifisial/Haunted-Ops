import { chromium, expect, test, type Page } from '@playwright/test';

const URL_ACCESSIBLE = '/?mode=accessible&demo=all-haunted';
const sceneRequests = (page: Page): string[] => {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (/SceneCanvas|pixi/i.test(r.url())) seen.push(r.url());
  });
  return seen;
};

test.describe('accessible mode', () => {
  let missing = false;
  test.beforeAll(async () => {
    try {
      const browser = await chromium.launch();
      await browser.close();
    } catch {
      missing = true;
    }
  });
  test.beforeEach(() => {
    test.skip(missing, 'Chromium is not installed. Run: PLAYWRIGHT_BROWSERS_PATH=0 pnpm --filter @haunted-ops/web exec playwright install chromium');
  });

  test('?mode=accessible loads no scene chunk and draws no canvas', async ({ page }) => {
    const requests = sceneRequests(page);
    await page.goto(URL_ACCESSIBLE);
    await expect(page.getByText('Demo data, not live')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accessible mode' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('row', { name: /payments/ })).toContainText('3 (possessed)');
    await page.waitForTimeout(1500);
    expect(requests).toEqual([]);
    await expect(page.locator('canvas')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-a11y', 'on');
  });

  test('the keyboard alone reaches the switch, every row and the detail', async ({ page }) => {
    await page.goto(URL_ACCESSIBLE);
    await expect(page.getByRole('row', { name: /ledger/ })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to services' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Accessible mode' })).toBeFocused();
    const reached = new Set<string>();
    for (let i = 0; i < 12 && reached.size < 4; i++) {
      await page.keyboard.press('Tab');
      const name = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest('tr[data-row]')?.getAttribute('data-row') ?? '');
      if (name !== '') reached.add(name);
    }
    expect([...reached].sort()).toEqual(['gate', 'ledger', 'orders', 'payments']);
    // The last row button has focus: open its detail with Enter, close it with Escape, focus stays on the row.
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Hunt on ledger' })).toBeVisible();
    await expect(page.getByRole('row', { name: /ledger/ })).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Hunt on ledger' })).toHaveCount(0);
    await expect(page.getByRole('row', { name: /ledger/ }).getByRole('button', { name: 'ledger' })).toBeFocused();
  });

  test('the switch off shows the canvas and on removes it', async ({ page }) => {
    await page.goto(URL_ACCESSIBLE);
    const toggle = page.getByRole('button', { name: 'Accessible mode' });
    await toggle.click();
    await expect(page.locator('#scene-mount canvas')).toBeVisible({ timeout: 45_000 });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(page.locator('canvas')).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  test('reduced motion turns the mode on when nothing is saved, and a saved off wins', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/?demo=all-haunted');
    const toggle = page.getByRole('button', { name: 'Accessible mode' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('canvas')).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Accessible mode' })).toHaveAttribute('aria-pressed', 'false');
  });
});
