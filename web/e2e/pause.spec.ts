import { expect, Page, test } from '@playwright/test';

// The system-level Pause and slow motion (D-362; SRD FR-92, revised; docs/v4-interfaces.md §4, §13.2), in both back
// ends. Pause freezes everything: icons hold where they are and can be clicked; no message is captured, no request
// completes, and the display client's replay time does not advance; Resume continues where Pause left off and nothing
// is lost. Slow motion slows the icons and back-pressures the system, so the drawing never falls far behind. The top
// bar no longer mirrors the display client's replay bar.
const SLOW = 300_000;

type SystemState = { paused: boolean; speed: number; held: boolean; lag: number; draw: number; live: number };
const sys = (page: Page) => page.evaluate(() => (globalThis as unknown as { bargeSystem: () => SystemState }).bargeSystem());
const captured = (page: Page) => page.evaluate(() => Object.values((globalThis as any).bargeCaptured() as Record<string, number>).reduce((a, b) => a + b, 0));
/** Every message the back end has captured, drawn or only counted (§13.4): it moves whenever a request is answered. */
const serverCount = (page: Page) => page.evaluate(() => Object.values(((globalThis as any).bargeControlState()?.capture_counts ?? {}) as Record<string, number>)
  .reduce((a, b) => a + b, 0));
/** Each icon on the flowchart: its label and where it is drawn. */
const icons = (page: Page) => page.getByTestId('message-icon').evaluateAll((els) => els.map((e) => `${e.getAttribute('aria-label')}@${(e as HTMLElement).style.transform}`).sort());
const liveModels = (page: Page) => page.evaluate(() => ((globalThis as any).bargeControlState()?.models ?? []).filter((m: any) => m.phase === 'live').length);

async function open(page: Page, backend: string) {
  await page.goto(`demo/?mission-a&backend=${backend}`);
  await expect(page.getByTestId('flowchart')).toBeVisible({ timeout: SLOW });
  await expect(page.getByTestId('flowchart')).toHaveAttribute('data-ready', 'true', { timeout: SLOW });
}

/** Logged in as the owner, Mission A open, the replay playing at 10× so the client polls. */
async function playing(page: Page) {
  await page.getByTestId('card-client').click();
  await page.getByTestId('demo-login-owner').click();
  await expect(page.getByTestId('chips')).toBeVisible({ timeout: SLOW });
  await page.getByTestId('dc-rate-10').click();
  await page.getByTestId('dc-play').click();
  await expect(page.getByTestId('replay-bar')).toHaveAttribute('data-playing', 'true');
}

/** Icons on the flowchart now: wait until some are drawn, then pause at once (the rush must be caught in flight). */
async function pauseWithIcons(page: Page) {
  await expect.poll(async () => (await sys(page)).live, { timeout: SLOW, intervals: [50] }).toBeGreaterThan(0);
  await page.getByTestId('system-pause').click();
  await expect(page.getByTestId('system-paused')).toBeVisible();
  await expect(page.getByTestId('system-pause')).toHaveText(/Resume/);
}

test('the top bar has no replay controls: the display client\'s replay bar is the only one (D-362)', async ({ page }) => {
  await open(page, 'standin');
  await expect(page.getByTestId('play')).toHaveCount(0);
  await expect(page.getByTestId('speed')).toHaveCount(0);
  await expect(page.getByTestId('controls').locator('[data-testid^="speed-"]')).toHaveCount(0);
  await expect(page.getByTestId('replay-reason')).toHaveCount(0);
  await expect(page.getByTestId('system-pause')).toBeEnabled();
  await expect(page.getByTestId('system-pause')).toHaveText(/Pause system/);
  for (const r of ['1', '0.5', '0.25']) await expect(page.getByTestId(`draw-speed-${r}`)).toBeEnabled();
  await expect(page.getByTestId('draw-speed-1')).toHaveAttribute('aria-pressed', 'true');
});

for (const backend of ['standin', 'python'] as const) {
  const name = backend === 'python' ? 'Python in Pyodide' : 'JavaScript stand-in';
  test.describe(`the system's Pause and slow motion, ${name}`, () => {
    test.describe.configure({ mode: 'serial' });

    test(`Pause freezes everything; a frozen icon opens its detail; Resume loses nothing, ${backend}`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await open(page, backend);
      await playing(page);
      const done: string[] = [];
      page.on('requestfinished', (r) => /\/demo\/api/.test(r.url()) && done.push(r.url()));
      await pauseWithIcons(page);
      await expect(page.getByTestId('system-pause')).toHaveAttribute('aria-pressed', 'true');
      expect((await sys(page)).held).toBe(true);
      // What was in flight as Pause was pressed may finish arriving; from then on nothing moves.
      await page.waitForTimeout(1000);
      const before = { icons: await icons(page), captured: await captured(page), server: await serverCount(page),
        draw: (await sys(page)).draw, time: await page.getByTestId('replay-bar').getAttribute('data-time'), done: done.length };
      expect(before.icons.length).toBeGreaterThan(0);
      await page.waitForTimeout(1200);
      // Icons hold where they are (sampled ~1 s apart), the drawing clock stands still.
      expect(await icons(page)).toEqual(before.icons);
      expect((await sys(page)).draw).toBe(before.draw);
      // No message is captured, by the shell or by the server, and no request completes.
      await page.waitForTimeout(1500);
      expect(await captured(page)).toBe(before.captured);
      expect(await serverCount(page)).toBe(before.server);
      expect(done.length).toBe(before.done);
      // The display client's replay time does not advance, though it is still playing.
      await expect(page.getByTestId('replay-bar')).toHaveAttribute('data-time', before.time!);
      await expect(page.getByTestId('replay-bar')).toHaveAttribute('data-playing', 'true');
      // A frozen icon is clicked and opens its message, as normal.
      const icon = page.getByTestId('message-icon').first();
      const label = (await icon.getAttribute('aria-label'))!;
      await icon.click();
      await expect(page.getByTestId('message-strip')).toBeVisible();
      await expect(page.getByTestId('selected-icon')).toBeVisible();
      expect(label).toMatch(/^[QDOKPHSLI] message: /);
      await page.getByTestId('message-strip').scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath(`paused-${backend}.png`) });
      // The picked icon is drawn as the selection, where it was; every other icon is still where it was.
      const after = await icons(page);
      expect(after.length).toBe(before.icons.length - 1);
      for (const i of after) expect(before.icons).toContain(i);
      // Resume: everything carries on from where it stopped, and nothing is lost.
      await page.getByTestId('system-pause').click();
      await expect(page.getByTestId('system-paused')).toHaveCount(0);
      await expect(page.getByTestId('system-pause')).toHaveText(/Pause system/);
      await expect.poll(() => captured(page), { timeout: 30_000 }).toBeGreaterThan(before.captured);
      await expect.poll(() => serverCount(page), { timeout: 30_000 }).toBeGreaterThan(before.server);
      await expect(page.getByTestId('replay-bar')).not.toHaveAttribute('data-time', before.time!, { timeout: 10_000 });
      const t0 = Date.parse(before.time!);
      expect(Date.parse((await page.getByTestId('replay-bar').getAttribute('data-time'))!) - t0).toBeLessThan(60_000 * 5); // continued, did not jump
      // The models' runs complete (nothing held for good), and the client shows their results.
      await expect.poll(() => liveModels(page), { timeout: SLOW, intervals: [1000] }).toBe(3);
      await expect(page.getByTestId('preparing')).toHaveCount(0, { timeout: SLOW });
      expect(errors).toEqual([]);
    });

    test(`slow motion: ¼× slows the icons, and the system waits so the drawing never falls far behind, ${backend}`, async ({ page }) => {
      await open(page, backend);
      await playing(page);
      await page.getByTestId('draw-speed-0.25').click();
      await expect(page.getByTestId('draw-speed-0.25')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('system-slow')).toBeVisible();
      // The drawing clock runs at a quarter of real time.
      const a = await sys(page);
      await page.waitForTimeout(2000);
      const b = await sys(page);
      expect(b.draw - a.draw).toBeGreaterThan(0.35);
      expect(b.draw - a.draw).toBeLessThan(0.7);
      // Each icon, followed from when it sets off until it arrives: a hop takes 1.2 s at 1×, 4.8 s at ¼× (a handshake's 0.3 s, 1.2 s).
      const life = await page.evaluate(async () => {
        const seen = new Map<Element, number>();
        const lives: number[] = [];
        const end = performance.now() + 12_000;
        while (performance.now() < end) {
          const now = performance.now();
          const els = new Set(document.querySelectorAll('[data-testid="message-icon"]'));
          for (const e of els) if (!seen.has(e)) seen.set(e, now);
          for (const [e, t] of seen) if (!els.has(e)) { lives.push(now - t); seen.delete(e); }
          await new Promise((r) => setTimeout(r, 50));
        }
        return lives;
      });
      expect(life.length).toBeGreaterThan(0);
      expect(Math.max(...life), `icon lifetimes ${life.map((x) => Math.round(x)).join(' ')}`).toBeGreaterThan(4000);
      // A queue built at 1×, before slow motion was chosen, drains first.
      await expect.poll(async () => (await sys(page)).lag, { timeout: 60_000 }).toBeLessThan(1.3);
      // While messages flow, the drawing's lag stays bounded: the system waits for it, so icons keep their spacing.
      const lags: number[] = [];
      let held = 0;
      for (let i = 0; i < 60; i++) {
        const s = await sys(page);
        lags.push(s.lag);
        if (s.held) held++;
        await page.waitForTimeout(250);
      }
      console.log(`${backend} at ¼×: longest icon ${Math.round(Math.max(...life))} ms; lag at most ${Math.max(...lags).toFixed(2)} s (drawing); held in ${held} of ${lags.length} samples`);
      expect(Math.max(...lags), `lags ${lags.map((x) => x.toFixed(1)).join(' ')}`).toBeLessThan(4);
      expect(held, 'the system was back-pressured at least once').toBeGreaterThan(0);
      // Nothing is lost and nothing is stuck: back to 1×, the models' runs complete.
      await page.getByTestId('draw-speed-1').click();
      await expect(page.getByTestId('system-slow')).toHaveCount(0);
      await expect.poll(() => liveModels(page), { timeout: SLOW, intervals: [1000] }).toBe(3);
      expect((await sys(page)).held).toBe(false);
    });

    test(`Pause is there during the rush after Adopt, and holds it for inspection, ${backend}`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`demo/?mission-a&hand-made&backend=${backend}`);
      await expect(page.getByTestId('flowchart')).toHaveAttribute('data-mode', 'opening');
      // Hidden in the opening (FR-122), there the moment the controls appear after Adopt, while the back end starts.
      await expect(page.getByTestId('system-pause')).toHaveCount(0);
      await page.getByTestId('open-standards').click();
      await page.getByTestId('choose-osh').click();
      // Enabled the moment it appears, whether or not the back end has started yet (FR-125a: Restart server waits for it).
      await expect(page.getByTestId('system-pause')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('system-pause')).toBeEnabled({ timeout: 1 });
      // A pause while the back end starts holds it there; the startup does not stall for it.
      await page.getByTestId('system-pause').click();
      await expect(page.getByTestId('system-pause')).toHaveText(/Resume/);
      await page.waitForTimeout(1500);
      await page.getByTestId('system-pause').click();
      await expect(page.getByTestId('flowchart')).toHaveAttribute('data-mode', 'normal', { timeout: SLOW });
      await expect(page.getByTestId('flowchart')).toHaveAttribute('data-ready', 'true', { timeout: SLOW });
      // The rush: the models processing Mission A, drawn. Pause catches it in flight.
      await pauseWithIcons(page);
      const frozen = await icons(page);
      expect(frozen.length).toBeGreaterThan(0);
      await page.waitForTimeout(1000);
      expect(await icons(page)).toEqual(frozen);
      await page.getByTestId('message-icon').first().click();
      await expect(page.getByTestId('message-strip')).toBeVisible();
      await page.getByTestId('message-strip').scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath(`paused-after-adopt-${backend}.png`) });
      await page.getByTestId('system-pause').click();
      await expect(page.getByTestId('system-paused')).toHaveCount(0);
      await expect.poll(() => liveModels(page), { timeout: SLOW, intervals: [1000] }).toBe(3);
      await expect(page.getByTestId('stall')).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test(`a failure demo resumes the system first, and Pause waits while it takes a step, ${backend}`, async ({ page }) => {
      await open(page, backend);
      await page.getByTestId('system-pause').click();
      await expect(page.getByTestId('system-paused')).toBeVisible();
      await page.getByTestId('demo-menu').click();
      await page.getByTestId('demo-restart').click();
      await expect(page.getByTestId('system-paused')).toHaveCount(0);
      await expect(page.getByTestId('demo-banner')).toBeVisible();
      await expect(page.getByTestId('demo-banner')).toHaveAttribute('data-running', 'false', { timeout: SLOW });
      await expect(page.getByTestId('system-pause')).toBeEnabled();
      await page.getByTestId('demo-reset').click();
      await expect(page.getByTestId('demo-banner')).toHaveCount(0, { timeout: SLOW });
    });
  });
}
