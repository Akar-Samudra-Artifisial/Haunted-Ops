import { expect, test } from '@playwright/test';

test('without WebGL: shows the message, hides the canvas and room buttons, keeps the table', async ({ page }) => {
  // Browser flags do not turn software WebGL off reliably, so refuse the contexts in the page.
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null;
      return (original as (...a: unknown[]) => unknown).call(this, type, ...rest);
    } as typeof original;
  });
  await page.goto('/?demo=payments-haunted');
  await expect(page.getByText('The house view is not available on this device.')).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('#scene-mount canvas')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Rooms' })).toHaveCount(0);
  await expect(page.getByRole('row', { name: /payments/ })).toContainText('2 (haunted)');
});
