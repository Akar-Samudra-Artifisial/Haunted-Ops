import { expect, test } from '@playwright/test';

test.describe('sound button (demo data)', () => {
  test('asks for no sound file before the click; after it the button reads "Sound on" and the files are requested', async ({ page }) => {
    const sfx: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/sfx/')) sfx.push(new URL(request.url()).pathname);
    });
    await page.goto('/?demo=1');
    const button = page.getByRole('button', { name: /^Sound (off|on)$/ });
    // Off by default, and nothing audio is fetched while the page runs.
    await expect(button).toHaveText('Sound off');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await page.waitForTimeout(1500);
    expect(sfx).toEqual([]);
    // The Accessible mode switch is still the first control after the skip link, and the sound button follows it.
    const names = await page.getByRole('banner').getByRole('button').allTextContents();
    expect(names.map((n) => n.trim())).toEqual(['○ Accessible mode', 'Sound off']);

    await button.click();
    await expect(button).toHaveText('Sound on');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => sfx.length, { timeout: 10_000 }).toBeGreaterThan(0);
    for (const path of sfx) expect(path).toMatch(/^\/sfx\/[a-z-]+\.mp3$/);
  });
});
