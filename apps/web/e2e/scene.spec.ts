import { mkdirSync } from 'node:fs';
import { chromium, expect, test, type Page } from '@playwright/test';

const SHOTS = 'test-results/screenshots';

interface PixelStats {
  distinct: number;
  differing: number;
  width: number;
  height: number;
}

/** Draws the screenshot in the page and counts colours and pixels that differ from the night background. */
async function pixelStats(page: Page, png: Buffer): Promise<PixelStats> {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d') as CanvasRenderingContext2D;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const [br, bg, bb] = [0x14, 0x12, 0x1c];
    const seen = new Set<number>();
    let differing = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] as number;
      const g = d[i + 1] as number;
      const b = d[i + 2] as number;
      seen.add(((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2));
      if (Math.abs(r - br) > 12 || Math.abs(g - bg) > 12 || Math.abs(b - bb) > 12) differing += 1;
    }
    return { distinct: seen.size, differing: differing / (d.length / 4), width: c.width, height: c.height };
  }, png.toString('base64'));
}

const cases = [
  { demo: 'payments-haunted', service: 'payments', level: '2 (haunted)', reason: 'error rate', hunt: 'none' },
  { demo: 'ledger-dark', service: 'ledger', level: '4 (dark)', reason: 'service down', hunt: 'none' },
  // The Hunt: the scene draws it and the table cell says the same words.
  { demo: 'payments-hunting', service: 'payments', level: '3 (possessed)', reason: 'error rate', hunt: 'running: step 3, logs' },
  { demo: 'payments-sealed', service: 'payments', level: '2 (haunted)', reason: 'error rate', hunt: 'sealed: d-7, 65c0fca' },
  { demo: 'payments-fizzled', service: 'payments', level: '3 (possessed)', reason: 'error rate', hunt: 'failed: credit cap reached' },
] as const;

test.describe('scene smoke test (software WebGL)', () => {
  let missing = false;
  test.beforeAll(async () => {
    // Headless runs use Playwright's own headless shell, so the only reliable check is to start it.
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

  for (const c of cases) {
    test(`?demo=${c.demo} draws a scene and the table says the same`, async ({ page }, info) => {
      mkdirSync(SHOTS, { recursive: true });
      await page.goto(`/?demo=${c.demo}`);

      await expect(page.getByText('Demo data, not live')).toBeVisible();
      const canvas = page.locator('#scene-mount canvas');
      await expect(canvas, 'the scene falls back to the message when WebGL cannot start').toBeVisible({ timeout: 45_000 });
      // Let the lights and the wisps finish fading in.
      await page.waitForTimeout(2500);

      const path = `${SHOTS}/${c.demo}.png`;
      const png = await canvas.screenshot({ path });
      const stats = await pixelStats(page, png);
      expect(stats.distinct, 'the canvas has colours').toBeGreaterThanOrEqual(16);
      expect(stats.differing, 'the canvas is not just the background').toBeGreaterThan(0.05);

      const row = page.getByRole('row', { name: new RegExp(`^(▶ )?${c.service}`) });
      await expect(row).toContainText(c.level);
      await expect(row).toContainText(c.reason);
      await expect(row).toContainText(c.hunt);

      // Frame statistics are published in Demo mode only: record them, do not assert (software rendering is slow).
      const frame = await page.evaluate(() => (window as unknown as { __hauntedScene?: unknown }).__hauntedScene ?? null);
      expect(frame).not.toBeNull();
      const summary = { demo: c.demo, screenshot: path, pixels: stats, frame };
      await info.attach('scene-stats', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' });
      console.log(`[scene-smoke] ${JSON.stringify(summary)}`);
    });
  }
});

test.describe('keyboard and fallback', () => {
  test('focusing a room by keyboard selects its table row and draws the ring', async ({ page }) => {
    mkdirSync(SHOTS, { recursive: true });
    await page.goto('/?demo=all-haunted');
    await expect(page.locator('#scene-mount canvas')).toBeVisible({ timeout: 45_000 });
    const rooms = page.getByRole('group', { name: 'Rooms' }).getByRole('button');
    await expect(rooms).toHaveCount(4);
    await rooms.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('row', { name: /orders/ })).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('tr[aria-current="true"]')).toHaveCount(0);
    await rooms.nth(3).focus();
    await page.waitForTimeout(1500);
    await page.locator('#scene-mount').screenshot({ path: `${SHOTS}/selected-ledger.png` });
    await expect(page.getByRole('row', { name: /ledger/ })).toHaveAttribute('aria-current', 'true');
  });
});

