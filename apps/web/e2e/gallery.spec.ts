import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// The visual review of task 9: every demo scenario at three widths, and the still version.
// Not part of the normal run. Start it with:  SCENE_GALLERY=1 pnpm --filter @haunted-ops/web test:e2e gallery
const SCENARIOS = [
  'calm',
  'payments-haunted',
  'payments-possessed',
  'orders-fog',
  'ledger-dark',
  'all-haunted',
  'payments-hunting',
  'payments-sealed',
  'payments-fizzled',
  'payments-fixing',
  'payments-fix-open',
  'payments-fix-deployed',
] as const;
const SIZES = [
  { width: 360, height: 800 },
  { width: 1280, height: 720 },
  { width: 3840, height: 2160 },
] as const;

test.describe('scene gallery', () => {
  test.skip(!process.env.SCENE_GALLERY, 'Set SCENE_GALLERY=1 to capture the gallery in apps/web/test-results/gallery/.');

  for (const name of SCENARIOS) {
    for (const size of SIZES) {
      test(`${name} at ${size.width}`, async ({ page }) => {
        mkdirSync('test-results/gallery', { recursive: true });
        await page.setViewportSize(size);
        await page.goto(`/?demo=${name}`);
        await expect(page.locator('#scene-mount canvas')).toBeVisible({ timeout: 45_000 });
        await page.waitForTimeout(3000);
        await page.locator('#scene-mount').screenshot({ path: `test-results/gallery/${name}-${size.width}.png` });
      });
    }
  }

  test('all-haunted with reduced motion is still', async ({ page }) => {
    mkdirSync('test-results/gallery', { recursive: true });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/?demo=all-haunted');
    await expect(page.locator('#scene-mount canvas')).toBeVisible({ timeout: 45_000 });
    await page.waitForTimeout(1500);
    const a = await page.locator('#scene-mount').screenshot({ path: 'test-results/gallery/all-haunted-reduced-1280.png' });
    await page.waitForTimeout(1500);
    const b = await page.locator('#scene-mount').screenshot();
    // No drifting, flicker or tremble: two shots a moment apart are the same picture.
    expect(b.equals(a)).toBe(true);
  });
});

test.describe('fix gallery, reduced motion', () => {
  test.skip(!process.env.SCENE_GALLERY, 'Set SCENE_GALLERY=1 to capture the gallery in apps/web/test-results/gallery/.');

  for (const name of ['payments-fixing', 'payments-fix-deployed'] as const) {
    test(`${name} with reduced motion is still`, async ({ page }) => {
      mkdirSync('test-results/gallery', { recursive: true });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`/?demo=${name}`);
      await expect(page.locator('#scene-mount canvas')).toBeVisible({ timeout: 45_000 });
      await page.waitForTimeout(1500);
      const a = await page.locator('#scene-mount').screenshot({ path: `test-results/gallery/${name}-reduced-1280.png` });
      await page.waitForTimeout(1500);
      const b = await page.locator('#scene-mount').screenshot();
      // The scroll does not glow and no sweep runs: two shots a moment apart are the same picture.
      expect(b.equals(a)).toBe(true);
    });
  }
});
