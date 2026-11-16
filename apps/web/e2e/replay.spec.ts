import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, test, type Page } from '@playwright/test';
const FILE = JSON.parse(readFileSync(join(process.cwd(), '../api/test/fixtures/replays/synthetic-error-spike.json'), 'utf8')) as { id: string; title: string; durationMs: number };
const CORS = { 'access-control-allow-origin': '*' };
/** The API is mocked: the list, the one file, and a 404 for any other id. Everything else is recorded. */
async function mockApi(page: Page): Promise<string[]> {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(new URL(r.url()).pathname));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/replays') {
      await route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify([{ id: FILE.id, title: FILE.title, scenario: 'error-spike', recordedOn: '2026-11-15', durationMs: FILE.durationMs }]) });
    } else if (url.pathname === `/api/replays/${FILE.id}`) {
      await route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(FILE) });
    } else if (url.pathname.startsWith('/api/replays/')) {
      await route.fulfill({ status: 404, headers: CORS, contentType: 'application/json', body: '{"error":"not_found"}' });
    } else {
      await route.fulfill({ status: 500, headers: CORS, body: '' });
    }
  });
  return requests;
}
test.describe('replay', () => {
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
  test('the list opens a replay; it plays, pauses and steps, and opens no stream', async ({ page }) => {
    const requests = await mockApi(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.addInitScript(() => window.localStorage.setItem('haunted-ops.a11y.v1', JSON.stringify({ mode: 'off' })));
    await page.goto('/replays');
    await page.getByRole('link', { name: FILE.title }).click();
    await expect(page).toHaveURL(new RegExp(`/replays/${FILE.id}$`));
    await expect(page.getByText('Replay of 2026-11-15, not live').first()).toBeVisible();
    const playButton = page.getByRole('button', { name: 'Play', exact: true });
    const range = page.getByRole('slider', { name: /Position/ });
    // Without reduced motion it starts playing: the position moves by itself.
    await expect(playButton).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '4×' }).click();
    await expect(range).not.toHaveAttribute('aria-valuetext', /^0 s of/, { timeout: 15_000 });
    await playButton.click();
    await expect(playButton).toHaveAttribute('aria-pressed', 'false');
    const held = await range.getAttribute('aria-valuetext');
    await page.waitForTimeout(1200);
    await expect(range).toHaveAttribute('aria-valuetext', held ?? '');
    const before = await range.inputValue();
    await page.getByRole('button', { name: 'Next frame' }).click();
    const stepped = Number(await range.inputValue());
    expect(stepped).toBeGreaterThan(Number(before));
    await page.getByRole('button', { name: 'Previous frame' }).click();
    expect(Number(await range.inputValue())).toBeLessThan(stepped);
    await range.focus();
    await expect(range).toBeFocused();
    expect(requests.filter((p) => p === '/api/events' || p === '/api/services' || p.startsWith('/api/hunts'))).toEqual([]);
  });
  test('Accessible mode: paused at the start, the table says the state of the frame, no scene chunk', async ({ page }) => {
    const requests = await mockApi(page);
    await page.goto(`/replays/${FILE.id}?mode=accessible`);
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('row', { name: /payments/ })).toContainText('0 (calm)');
    await page.getByRole('slider', { name: /Position/ }).fill(String(FILE.durationMs - 40_000));
    await expect(page.getByRole('slider', { name: /Position/ })).toHaveAttribute('aria-valuetext', /of 3 min 20 s$/);
    await expect(page.getByRole('row', { name: /payments/ })).toContainText(/Hunt|hunt|diagnos|sealed/);
    await expect(page.getByRole('table').locator('caption')).toContainText('Replay of 2026-11-15, not live');
    await expect(page.locator('canvas')).toHaveCount(0);
    expect(requests.filter((p) => /SceneCanvas|pixi/i.test(p) || p === '/api/events')).toEqual([]);
  });
  test('an unknown replay says so and links to the list', async ({ page }) => {
    await mockApi(page);
    await page.goto('/replays/does-not-exist');
    await expect(page.getByRole('heading', { name: 'This replay does not exist' })).toBeVisible();
    await page.getByRole('link', { name: 'See the replays' }).click();
    await expect(page).toHaveURL(/\/replays$/);
  });
  test('the replay chunk is not requested on the live page', async ({ page }) => {
    const seen: string[] = [];
    page.on('request', (r) => seen.push(r.url()));
    await page.goto('/?mode=accessible&demo=calm');
    await expect(page.getByRole('row', { name: /payments/ })).toBeVisible();
    await page.waitForTimeout(800);
    expect(seen.filter((u) => /ReplayApp|\/src\/replay\//.test(new URL(u).pathname))).toEqual([]);
  });
});
