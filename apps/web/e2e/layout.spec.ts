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
