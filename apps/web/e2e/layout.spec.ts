import { expect, test } from '@playwright/test';
// Feature: visual-refresh, layout: no sideways page scroll on a phone, and the Panel beside the Scene on a desktop.
test.describe('layout', () => {
  test.describe('at 390 x 844', () => {
    test.use({ viewport: { width: 390, height: 844 } });
    for (const path of ['/?demo=1', '/?mode=accessible&demo=1', '/replays']) {
      test(`${path} has no horizontal scroll`, async ({ page }) => {
        await page.route('**/api/replays', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        const width = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(width).toBeLessThanOrEqual(390);
      });
    }
  });
  // The page reads: summary bar, Hunt, scene, service cards (the focus order stays the DOM order).
  test.describe('mobile order at 390 x 844', () => {
    test.use({ viewport: { width: 390, height: 844 } });
    test('the summary bar and the Hunt come first, then the scene, then the service cards', async ({ page }) => {
      await page.goto('/?demo=1');
      const top = async (selector: string): Promise<number> => {
        const box = await page.locator(selector).first().boundingBox();
        expect(box, selector).not.toBeNull();
        return box!.y;
      };
      await expect(page.locator('#scene-mount')).toBeVisible();
      const [summary, hunt, scene, cards, legend] = await Promise.all([top('[data-testid="summary-bar"]'), top('.hunt-section'), top('#scene-mount'), top('.table-mode'), top('.legend')]);
      expect(summary).toBeLessThan(hunt);
      expect(hunt).toBeLessThan(scene);
      expect(scene).toBeLessThan(cards);
      expect(cards).toBeLessThan(legend);
      // The DOM and the focus order are unchanged: the skip link and the mode switch still come first.
      const first = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll<HTMLElement>('a[href], button, [tabindex="0"]')).filter((el) => !el.closest('[hidden]'));
        return items.slice(0, 2).map((el) => (el.textContent ?? '').trim().toLowerCase());
      });
      expect(first[0]).toContain('skip');
    });
  });
  for (const width of [1440, 1024]) {
    test.describe(`table columns at ${width} x 900`, () => {
      test.use({ viewport: { width, height: 900 } });
      test(`keep their width when the values change (demo at 0 s and at 20 s), and clip no text`, async ({ page }) => {
        test.setTimeout(60_000);
        await page.goto('/?demo=1');
        const headers = page.getByRole('columnheader');
        await expect(headers).toHaveCount(9);
        const widths = async (): Promise<number[]> => (await headers.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width * 10) / 10)));
        const before = await widths();
        await page.waitForTimeout(20_500);
        const after = await widths();
        expect(after).toEqual(before);
        // No cell clips its text: the content of every cell fits its box (the scroll area, not the cell, takes any overflow).
        const clipped = await page.locator('.table-mode td, .table-mode th').evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).length);
        expect(clipped).toBe(0);
      });
    });
  }
  test.describe('at 1440 x 900', () => {
    test.use({ viewport: { width: 1440, height: 900 } });
    test('the Panel is beside the Scene', async ({ page }) => {
      await page.goto('/?demo=1');
      const scene = page.locator('#scene-mount');
      const panel = page.getByRole('complementary', { name: 'Incident' });
      await expect(scene).toBeVisible();
      await expect(panel).toBeVisible();
      const [a, b] = await Promise.all([scene.boundingBox(), panel.boundingBox()]);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(b!.x).toBeGreaterThanOrEqual(a!.x + a!.width - 1);
      expect(Math.abs(b!.width - 360)).toBeLessThanOrEqual(1);
    });
  });
});
