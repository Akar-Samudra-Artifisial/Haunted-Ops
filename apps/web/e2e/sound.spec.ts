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

  test('the click makes a running context and a cue starts within 3 s (the confirmation)', async ({ page, browserName }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __sound: { starts: number; contexts: AudioContext[] } };
      w.__sound = { starts: 0, contexts: [] };
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, ...args: Parameters<typeof start>) {
        w.__sound.starts += 1;
        return start.apply(this, args);
      };
      const Native = window.AudioContext;
      window.AudioContext = class extends Native {
        constructor(options?: AudioContextOptions) {
          super(options);
          w.__sound.contexts.push(this);
        }
      };
    });
    await page.goto('/?demo=1');
    const button = page.getByRole('button', { name: /^Sound (off|on)$/ });
    await expect(button).toHaveText('Sound off');
    await button.click();
    const started = Date.now();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sound: { starts: number } }).__sound.starts), { timeout: 3_000, intervals: [50] }).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(3_000);
    const state = await page.evaluate(() => (window as unknown as { __sound: { contexts: AudioContext[] } }).__sound.contexts.map((c) => c.state));
    expect(state).toHaveLength(1);
    if (browserName === 'chromium') expect(state[0]).toBe('running');
    await expect(button).toHaveText('Sound on');
  });
});
