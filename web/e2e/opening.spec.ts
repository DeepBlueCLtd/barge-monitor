import { expect, Page, Request, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

// The adoption opening (plan Phase 9; SRD 4.7 §9.8, AT-62 to AT-67; docs/v4-interfaces.md §12), in both back ends:
// the JavaScript stand-in and the Python back end in Pyodide. The opening is the same in both, because nothing runs
// before Adopt (FR-122); what follows Adopt is each back end's own startup. Each test loads the page afresh in its
// own browser context, so no Service Worker is left over from an earlier test.
const SLOW = 300_000;
const A = 'MISSION_A_20310407.csv';

type Rect = [number, number, number, number];
type Box = { x: number; y: number; width: number; height: number };
const readJson = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const layout = readJson('../src/shell/layout.json') as { zones: { id: string; rect: Rect }[]; cards: Record<string, Rect>; arrows: { src: string; dst: string; path: number[][] }[] };
const openingLayout = readJson('../src/shell/layout-opening.json') as { zones: { id: string; rect: Rect }[]; cards: Record<string, Rect>; lines: { a: string; b: string; path: number[][] }[] };

const SUBS = ['sub-webapi', 'sub-registry', 'sub-obsstore', 'sub-query', 'sub-commands', 'sub-accounts', 'sub-permissions', 'sub-admin'];
/** Written by us either way, beside the subsystems in the back end (FR-120, 4.7: no replay controller, no gateway). */
const BACK = ['importer', 'models'];
const CONTROLS = ['play', 'speed', 'restart-client', 'restart-server', 'demo-menu', 'control-panel-toggle', 'overview-button', 'custom-backend-link'];
/** FR-120a: every flow of the opening, as "from>to". */
const LINES = ['client>sub-webapi', 'models>sub-webapi', 'sub-commands>importer', 'sub-commands>models', 'importer>sub-obsstore', 'importer>sub-registry',
  'sub-webapi>sub-query', 'sub-webapi>sub-registry', 'sub-webapi>sub-commands', 'sub-webapi>sub-permissions', 'sub-query>sub-obsstore',
  'sub-accounts>sub-permissions', 'sub-admin>sub-webapi', 'models>scilibs', 'importer>folder'];
const LEAD = 'Written ourselves, the system is a range of components to develop. Which of them could be adopted rather than written is not yet decided.';
/** D-359: every component of the opening has a row in the table, in the flowchart's order. */
const ROW_IDS = ['client', 'models', 'importer', ...SUBS, 'scilibs', 'folder'];

/** Words the 4.7 opening must never use (4.7: no access gateway, no replay controller, no Freeze; no count of subsystems). */
const GONE = /gateway|replay controller|freeze|\beight\b/i;

/** Count every worker the page creates (AT-63: no back-end or model worker before Adopt). */
async function countWorkers(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __workers: string[]; Worker: typeof Worker };
    w.__workers = [];
    const Base = w.Worker;
    w.Worker = class extends Base {
      constructor(url: string | URL, opts?: WorkerOptions) {
        super(url, opts);
        w.__workers.push(String(url));
      }
    };
  });
}
const workers = (page: Page) => page.evaluate(() => (window as unknown as { __workers: string[] }).__workers.length);

async function box(page: Page, testId: string): Promise<Box> {
  const b = await page.getByTestId(testId).boundingBox();
  expect(b, testId).not.toBeNull();
  return b!;
}

const inside = (inner: Box, outer: Box, slack = 1) =>
  inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.width <= outer.x + outer.width + slack && inner.y + inner.height <= outer.y + outer.height + slack;

/** Every polyline segment is horizontal or vertical and crosses no card it does not start or end on (VS-13). */
function crossings(cards: Record<string, Rect>, paths: { id: string; path: number[][] }[]): string[] {
  const out: string[] = [];
  for (const { id, path } of paths) {
    for (let i = 1; i < path.length; i++) {
      const [x1, y1] = path[i - 1], [x2, y2] = path[i];
      if (x1 !== x2 && y1 !== y2) out.push(`${id}: diagonal segment`);
      for (const [c, [rx, ry, rw, rh]] of Object.entries(cards)) {
        const hit = x1 === x2
          ? rx + 1 < x1 && x1 < rx + rw - 1 && Math.min(y1, y2) < ry + rh - 1 && Math.max(y1, y2) > ry + 1
          : ry + 1 < y1 && y1 < ry + rh - 1 && Math.min(x1, x2) < rx + rw - 1 && Math.max(x1, x2) > rx + 1;
        if (hit) out.push(`${id} crosses ${c}`);
      }
    }
  }
  return out;
}

/** Each end of a line touches the edge of the card it names. */
function ends(cards: Record<string, Rect>, lines: { a: string; b: string; path: number[][] }[]): string[] {
  const onEdge = ([x, y]: number[], [rx, ry, rw, rh]: Rect) =>
    ((x === rx || x === rx + rw) && y >= ry && y <= ry + rh) || ((y === ry || y === ry + rh) && x >= rx && x <= rx + rw);
  return lines.flatMap((l) => [
    ...(onEdge(l.path[0], cards[l.a]) ? [] : [`${l.a}>${l.b} does not start on ${l.a}`]),
    ...(onEdge(l.path[l.path.length - 1], cards[l.b]) ? [] : [`${l.a}>${l.b} does not end on ${l.b}`]),
  ]);
}

test('the fixed layouts: two rows of five, the subsystem cards the size of the importer and Models; no line crosses a card (FR-120, FR-120a, VS-13)', () => {
  const oc = openingLayout.cards;
  const normal = layout.arrows.map((a) => ({ id: `${a.src}>${a.dst}`, path: a.path }));
  expect(crossings(layout.cards, normal)).toEqual([]);
  expect(crossings(oc, openingLayout.lines.map((l) => ({ id: `${l.a}>${l.b}`, path: l.path })))).toEqual([]);
  expect(ends(oc, openingLayout.lines)).toEqual([]);
  expect(openingLayout.lines.map((l) => `${l.a}>${l.b}`).sort()).toEqual([...LINES].sort());
  for (const cards of [layout.cards, oc]) {
    const list = Object.entries(cards);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, [ax, ay, aw, ah]] = list[i], [b, [bx, by, bw, bh]] = list[j];
        expect(ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah, `${a} overlaps ${b}`).toBe(false);
      }
    }
  }
  // FR-120: no data server in the opening; the back end in two rows of five, every card the same size, on one grid.
  expect(oc.server).toBeUndefined();
  const ids = [...BACK, ...SUBS];
  expect(Object.keys(oc).filter((id) => !['client', 'scilibs', 'folder'].includes(id)).sort()).toEqual([...ids].sort());
  expect(new Set(ids.map((id) => `${oc[id][2]}x${oc[id][3]}`)).size).toBe(1);
  const rows = new Map<number, number>();
  for (const id of ids) rows.set(oc[id][1], (rows.get(oc[id][1]) ?? 0) + 1);
  expect([...rows.values()]).toEqual([5, 5]);
  const cols = new Set(ids.map((id) => oc[id][0]));
  expect(cols.size).toBe(5);
  // docs/v4-interfaces.md §12: which cards are in which row (D-331 orders row 1 so the merge never crosses two cards).
  const row = (y: number) => ids.filter((id) => oc[id][1] === y).sort();
  const [r1, r2] = [...rows.keys()].sort((a, b) => a - b);
  expect(row(r1)).toEqual(['importer', 'models', 'sub-obsstore', 'sub-registry', 'sub-webapi']);
  expect(row(r2)).toEqual(['sub-accounts', 'sub-admin', 'sub-commands', 'sub-permissions', 'sub-query']);
  // ...the same size as the importer and Models in the normal layout, so the merge only moves them (VS-25, D-330).
  for (const id of BACK) expect(layout.cards[id].slice(2)).toEqual(oc[id].slice(2));
  // The zones below the back end move down by one card row; the others stay.
  const z = (l: typeof layout, id: string) => l.zones.find((x) => x.id === id)!.rect;
  for (const id of ['front', 'third']) expect(z(openingLayout as typeof layout, id)).toEqual(z(layout, id));
  expect(z(openingLayout as typeof layout, 'legacy')[1] - z(layout, 'legacy')[1]).toBe(z(openingLayout as typeof layout, 'back')[3] - z(layout, 'back')[3]);
});

test('the opening\'s words: "a range of subsystem components", never a count, a gateway, a replay controller or Freeze (FR-120, FR-123, D-230)', () => {
  const src = ['../src/shell/opening.ts', '../src/detail/OpeningPanel.tsx'].map((f) => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  expect(src).toContain(LEAD);
  expect(src).not.toMatch(GONE);
});

for (const backend of ['standin', 'python'] as const) {
  const name = backend === 'python' ? 'Python in Pyodide' : 'JavaScript stand-in';
  const flag = `demo/?hand-made&backend=${backend}`;

  test.describe(`the adoption opening, ${name}`, () => {
    async function openOpening(page: Page, url = flag) {
      await countWorkers(page);
      await page.goto(url);
      await expect(page.getByTestId('opening-panel')).toBeVisible();
      await expect(page.getByTestId('flowchart')).toHaveAttribute('data-mode', 'opening');
    }

    test(`AT-62: without the flag the normal startup; with it the opening; a reload repeats it, ${backend}`, async ({ page }) => {
      await countWorkers(page);
      await page.goto(`demo/?backend=${backend}`);
      // FR-77: the back end starts at once (its worker is created) and no opening is shown.
      await expect.poll(() => workers(page), { timeout: 30_000 }).toBeGreaterThan(0);
      // The normal startup: its named steps, or, once the server answers (the stand-in's in well under a second), the
      // flowchart in its normal mode; never the opening's.
      await expect(page.getByTestId('startup-steps').or(page.locator('[data-testid="flowchart"][data-mode="normal"]'))).toBeVisible();
      await expect(page.getByTestId('flowchart').and(page.locator('[data-mode="opening"]'))).toHaveCount(0);
      await expect(page.getByTestId('opening-panel')).toHaveCount(0);
      await expect(page.getByTestId('card-sub-webapi')).toHaveCount(0);
      await openOpening(page);
      await expect(page.getByTestId('switch-build')).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('switch-adopt')).toHaveAttribute('aria-checked', 'false');
      await page.reload();
      await expect(page.getByTestId('opening-panel')).toBeVisible();
      await expect(page.getByTestId('flowchart')).toHaveAttribute('data-mode', 'opening');
      await expect(page.getByTestId('switch-build')).toHaveAttribute('aria-checked', 'true');
      // Any value, or none, is the flag (FR-119).
      await openOpening(page, `demo/?backend=${backend}&hand-made=yes`);
    });

    test(`the top bar's "Custom backend" link reloads this page on the opening, keeping its other parameters (D-353), ${backend}`, async ({ page }) => {
      await page.goto(`demo/?backend=${backend}`);
      const link = page.getByTestId('custom-backend-link');
      await expect(link).toBeVisible();
      await expect(link).toBeEnabled();
      const href = new URL((await link.getAttribute('href'))!, page.url());
      expect(href.searchParams.get('backend')).toBe(backend);
      expect(href.searchParams.has('hand-made')).toBe(true);
      await link.click();
      await expect(page.getByTestId('opening-panel')).toBeVisible();
      await expect(page.getByTestId('flowchart')).toHaveAttribute('data-mode', 'opening');
      expect(new URL(page.url()).searchParams.get('backend')).toBe(backend);
    });

    test(`AT-63: in the opening nothing runs, nothing is gold, and clicks reveal nothing, ${backend}`, async ({ page }) => {
      const requests: string[] = [];
      page.on('request', (r: Request) => /\/api(\/|\?|$)/.test(new URL(r.url()).pathname) && requests.push(r.url()));
      await openOpening(page);
      // FR-122: no top-bar control and no stand-in banner in the page; only the title.
      for (const id of CONTROLS) await expect(page.getByTestId(id)).toHaveCount(0);
      await expect(page.getByTestId('controls')).toHaveCount(0);
      await expect(page.locator('.topbar button')).toHaveCount(0);
      await expect(page.getByTestId('standin-notice')).toHaveCount(0);
      await expect(page.getByTestId('demo-banner')).toHaveCount(0);
      expect((await page.locator('.topbar').innerText()).trim()).toBe('Canal barge weather demonstrator');
      await expect(page.locator('body')).not.toContainText('stand-in');
      // The status shows only "Opening", and that the icons are illustrative traffic (D-361).
      expect((await page.getByTestId('status-box').innerText()).replace(/\s+/g, ' ').trim().toLowerCase()).toBe('status opening · illustrative traffic');
      // No worker, no relay, no request, no message captured or drawn.
      await page.waitForTimeout(3000);
      expect(await workers(page)).toBe(0);
      expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
      expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
      expect(requests).toEqual([]);
      expect(await page.evaluate(() => (globalThis as any).bargeCaptured())).toEqual({});
      expect(await page.evaluate(() => (globalThis as any).bargeControlState())).toBeNull();
      await expect(page.getByTestId('message-icon')).toHaveCount(0);
      await expect(page.locator('.flowchart [data-letter]')).toHaveCount(0);
      await expect(page.locator('[data-testid^="key-"]')).toHaveCount(0);
      await expect(page.locator('[data-flow]')).toHaveCount(0);
      // FR-120a: the flows as plain lines, without letters or labels.
      const drawn = await page.locator('[data-line]').evaluateAll((els) => els.map((e) => e.getAttribute('data-line')));
      expect(drawn.sort()).toEqual([...LINES].sort());
      await expect(page.getByTestId('opening-lines').locator('text')).toHaveCount(0);
      // No data server, and the third-party zone holds the scientific libraries only.
      await expect(page.getByTestId('card-server')).toHaveCount(0);
      const third = (await page.locator('[data-zone="third"]').boundingBox())!;
      const inThird: string[] = [];
      for (const c of await page.locator('.card').all()) if (inside((await c.boundingBox())!, third)) inThird.push((await c.getAttribute('data-testid'))!);
      expect(inThird).toEqual(['card-scilibs']);
      // FR-121: nothing gold, no ★, no diamond, no "value-add", anywhere.
      const noGold = async () => {
        await expect(page.locator('.gold, [data-revealed="true"], .va-pill, .card-diamond, .diamond')).toHaveCount(0);
        const text = await page.locator('body').innerText();
        expect(text).not.toContain('★');
        expect(text.toLowerCase()).not.toContain('value-add');
      };
      await noGold();
      // Clicking the display client, Models or any other component card highlights its row and reveals nothing (FR-121, FR-123, D-359).
      for (const id of ['client', 'models', 'importer', 'scilibs', 'folder']) {
        await page.getByTestId(`card-${id}`).click();
        await expect(page.getByTestId('detail-panel')).toHaveAttribute('data-showing', 'opening');
        await expect(page.getByTestId(`row-${id}`)).toHaveClass(/highlighted/);
        await expect(page.locator('.opening-table tr.highlighted')).toHaveCount(1);
      }
      await noGold();
      await expect(page.getByTestId('dc-login')).toHaveCount(0); // the display client does not even show its login (FR-122)
      // Clicking a subsystem card highlights its row (FR-123).
      await page.getByTestId('card-sub-obsstore').click();
      await expect(page.getByTestId('row-sub-obsstore')).toHaveClass(/highlighted/);
      await page.getByTestId('card-sub-accounts').click();
      await expect(page.getByTestId('row-sub-accounts')).toHaveClass(/highlighted/);
      await expect(page.locator('.opening-table tr.highlighted')).toHaveCount(1);
      // FR-123, D-359: the lead, and one table of every component, each with what it does; before Adopt nothing says
      // which could be adopted rather than written.
      await expect(page.getByTestId('opening-lead')).toHaveText(LEAD);
      expect(await page.getByTestId('opening-table').locator('tbody tr').evaluateAll((rs) => rs.map((r) => r.getAttribute('data-testid')))).toEqual(ROW_IDS.map((id) => `row-${id}`));
      for (const id of ROW_IDS) expect((await page.getByTestId(`row-${id}`).locator('td').nth(1).innerText()).trim()).not.toBe('');
      await expect(page.getByTestId('row-sub-permissions')).toContainText('Who may see and change what');
      await expect(page.getByTestId('written-either-way')).toHaveCount(0);
      // The table itself says nothing of what is written or adopted: there is no such column yet.
      expect(await page.getByTestId('opening-table').innerText()).not.toMatch(/written by us|adopted|unchanged|OpenSensorHub/i);
      await expect(page.getByTestId('tick')).toHaveCount(0);
      expect(await page.locator('body').innerText()).not.toMatch(GONE);
      await noGold();
      expect(await workers(page)).toBe(0);
      expect(requests).toEqual([]);
    });

    test(`D-361: illustrative traffic travels the opening's lines, from the page alone; it stops at Adopt and never reaches the real traffic, ${backend}`, async ({ page }) => {
      test.setTimeout(SLOW * 2);
      const requests: string[] = [];
      page.on('request', (r: Request) => /\/api(\/|\?|$)/.test(new URL(r.url()).pathname) && requests.push(r.url()));
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await openOpening(page);
      const mock = page.getByTestId('mock-icon');
      await expect.poll(() => mock.count(), { timeout: 5_000 }).toBeGreaterThan(0);
      // Where each icon is, in layout units (the flowchart is at scale 1 on the 1920 x 1080 target), and its letter.
      const icons = () => page.locator('[data-testid="mock-icon"]').evaluateAll((els) => els.map((e) => {
        const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec((e as HTMLElement).style.transform)!;
        return { letter: e.getAttribute('data-mock-letter')!, x: Number(m[1]) + 19, y: Number(m[2]) + 19 };
      }));
      const onLine = ({ x, y }: { x: number; y: number }) => openingLayout.lines.some(({ path }) => path.slice(1).some(([x2, y2], i) => {
        const [x1, y1] = path[i];
        return x1 === x2 ? Math.abs(x - x1) < 1 && y >= Math.min(y1, y2) - 1 && y <= Math.max(y1, y2) + 1
          : Math.abs(y - y1) < 1 && x >= Math.min(x1, x2) - 1 && x <= Math.max(x1, x2) + 1;
      }));
      // Over several seconds: icons on the opening's lines only, moving, with the real letters, several flows' worth.
      const letters = new Set<string>();
      let moved = false;
      let most = 0;
      for (let i = 0; i < 40; i++) {
        const a = await icons();
        await page.waitForTimeout(250);
        const b = await icons();
        for (const ic of [...a, ...b]) {
          expect(onLine(ic), `${ic.letter} at ${ic.x},${ic.y} is on an opening line`).toBe(true);
          letters.add(ic.letter);
        }
        if (a.length && b.length && b.some((q) => !a.some((p) => Math.abs(p.x - q.x) < 0.5 && Math.abs(p.y - q.y) < 0.5))) moved = true;
        most = Math.max(most, a.length, b.length);
      }
      expect(moved, 'the icons move').toBe(true);
      expect(most, 'several at once').toBeGreaterThanOrEqual(2);
      for (const l of letters) expect('QDOKHSLI').toContain(l);
      expect(letters.size).toBeGreaterThanOrEqual(3);
      // Not messages: not buttons, not clickable, hidden from assistive technology, and nothing captured, counted or drawn as one.
      // (Read in one go: an icon is removed as it arrives.)
      let looks: string[] = [];
      await expect.poll(async () => (looks = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="mock-icon"]')).map((e) =>
        JSON.stringify({ tag: e.tagName, pe: getComputedStyle(e).pointerEvents, hidden: !!e.closest('[aria-hidden="true"]') })))).length, { timeout: 10_000 }).toBeGreaterThan(0);
      expect([...new Set(looks)]).toEqual([JSON.stringify({ tag: 'DIV', pe: 'none', hidden: true })]);
      await expect(page.getByTestId('message-icon')).toHaveCount(0);
      await expect(page.locator('.flowchart [data-letter]')).toHaveCount(0);
      expect(await page.evaluate(() => (globalThis as any).bargeCaptured())).toEqual({});
      expect(await page.evaluate(() => (globalThis as any).bargeMessages())).toEqual([]);
      // Still nothing runs (FR-122, AT-63): no worker, no relay, no request.
      expect(await workers(page)).toBe(0);
      expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
      expect(requests).toEqual([]);
      expect(await page.locator('body').innerText()).not.toMatch(GONE);
      expect(await page.locator('body').innerText()).not.toMatch(/\d/);
      // Adopt: the traffic stops at once. Every animation frame from the click records whether a mock icon is drawn.
      await page.evaluate(() => {
        const w = window as unknown as { __mock: { click: number; last: number; frames: number } };
        w.__mock = { click: 0, last: -1, frames: 0 };
        document.querySelector('[data-testid="switch-adopt"]')!.addEventListener('click', () => { w.__mock.click = performance.now(); }, { capture: true });
        const loop = () => {
          const m = w.__mock;
          if (m.click) {
            m.frames++;
            if (document.querySelector('[data-testid="mock-icon"]')) m.last = performance.now() - m.click;
          }
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      });
      await expect.poll(() => mock.count(), { timeout: 10_000 }).toBeGreaterThan(0);
      await page.getByTestId('switch-adopt').click();
      await expect(page.getByTestId('flowchart')).toHaveAttribute('data-mode', 'merging');
      await page.waitForTimeout(500);
      // Sampled shortly after the click: none left, while the cards are still merging.
      await expect(mock).toHaveCount(0);
      expect(await page.getByTestId('flowchart').getAttribute('data-mode')).toBe('merging');
      const seen = await page.evaluate(() => (window as unknown as { __mock: { last: number; frames: number } }).__mock);
      expect(seen.frames).toBeGreaterThan(5);
      expect(seen.last, 'ms after the click that a mock icon was last drawn').toBeLessThan(400);
      await expect(page.getByTestId('status-illustrative')).toHaveCount(0);
      // After hand-over: none again, and the real traffic is the system's own.
      await expect(page.getByTestId('flowchart')).toHaveAttribute('data-mode', 'normal', { timeout: SLOW });
      await expect(page.getByTestId('flowchart')).toHaveAttribute('data-ready', 'true', { timeout: SLOW });
      await page.getByTestId('card-client').click();
      await page.getByTestId('demo-login-owner').click();
      await expect(page.getByTestId('chips')).toBeVisible({ timeout: SLOW });
      await expect(page.getByTestId('message-icon').first()).toBeAttached({ timeout: SLOW });
      await expect(mock).toHaveCount(0);
      const real = await page.evaluate(() => (globalThis as any).bargeMessages() as { src: string; dst: string }[]);
      expect(real.length).toBeGreaterThan(0);
      expect(real.filter((m) => /^sub-/.test(m.src) || /^sub-/.test(m.dst))).toEqual([]);
      expect(Object.keys(await page.evaluate(() => (globalThis as any).bargeCaptured())).filter((k) => k.includes('sub-'))).toEqual([]);
      await expect(page.getByTestId('message-strip')).toBeVisible();
      expect(errors).toEqual([]);
    });

    test(`AT-64: the subsystem cards are the equals of the CSV importer and Models, ungrouped and uncounted, ${backend}`, async ({ page }) => {
      await openOpening(page);
      const ids = [...BACK, ...SUBS];
      const boxes = await Promise.all(ids.map((id) => box(page, `card-${id}`)));
      for (const b of boxes) {
        expect(Math.abs(b.width - boxes[0].width)).toBeLessThan(0.5);
        expect(Math.abs(b.height - boxes[0].height)).toBeLessThan(0.5);
      }
      // Every card's name and role fit inside it.
      const overflowing = await page.locator('.card').evaluateAll((els) => els.filter((e) => e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1).map((e) => e.getAttribute('data-testid')));
      expect(overflowing).toEqual([]);
      // Two rows of five on one grid (FR-120, 4.7).
      const rows = new Map<number, number>();
      for (const b of boxes) rows.set(Math.round(b.y), (rows.get(Math.round(b.y)) ?? 0) + 1);
      expect([...rows.values()]).toEqual([5, 5]);
      expect(new Set(boxes.map((b) => Math.round(b.x))).size).toBe(5);
      // The same card style: fill, font, outline (VS-25), all drawn by the sketch renderer.
      const style = (id: string) => page.getByTestId(`card-${id}`).evaluate((el) => {
        const s = getComputedStyle(el), n = getComputedStyle(el.querySelector('.card-name')!), r = getComputedStyle(el.querySelector('.card-role')!);
        const paths = Array.from(el.querySelectorAll(':scope > svg.sketch path')).map((p) => `${p.getAttribute('stroke')}/${p.getAttribute('stroke-width')}`);
        return JSON.stringify({
          bg: s.backgroundColor, border: s.border, radius: s.borderRadius, shadow: s.boxShadow, padding: s.padding, opacity: s.opacity,
          name: [n.fontFamily, n.fontSize, n.fontWeight, n.color, n.lineHeight], role: [r.fontFamily, r.fontSize, r.color],
          outline: [...new Set(paths)], sketched: paths.length > 0, classes: el.className,
        });
      });
      const ref = await style('importer');
      expect(JSON.parse(ref).sketched).toBe(true);
      for (const id of ids) expect(await style(id), id).toBe(ref);
      // No element encloses or labels the subsystems as a group: anything around all of them is also around the importer and Models.
      const enclosing = await page.evaluate(({ subs, back }) => {
        const r = (id: string) => document.querySelector(`[data-testid="card-${id}"]`)!.getBoundingClientRect();
        const around = (o: DOMRect, i: DOMRect) => o.left <= i.left + 0.5 && o.top <= i.top + 0.5 && o.right >= i.right - 0.5 && o.bottom >= i.bottom - 0.5;
        const s = subs.map(r), b = back.map(r);
        const bad: string[] = [];
        for (const el of Array.from(document.querySelectorAll('body *'))) {
          const box = el.getBoundingClientRect();
          if (box.width === 0 || box.height === 0) continue;
          if (s.every((x) => around(box, x)) && !b.every((x) => around(box, x))) bad.push(`${el.tagName}.${el.getAttribute('class') ?? ''}`);
        }
        return bad;
      }, { subs: SUBS, back: BACK });
      expect(enclosing).toEqual([]);
      // The back end's zone label is the same as without the flag: nothing labels the subsystems.
      await expect(page.locator('[data-zone="back"] .zone-label')).toHaveText('New build · back end');
      // No count of them anywhere on the page: no digit at all.
      expect(await page.locator('body').innerText()).not.toMatch(/\d/);
    });

    test(`AT-65, AT-67: Adopt merges the subsystems one at a time into one Data server card, the back end starting meanwhile, and the flowchart stays on screen; nothing plays before login, a dataset and Play, ${backend}`, async ({ page, browser }) => {
      test.setTimeout(SLOW * 3);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const log = clientLog(page);
      await openOpening(page);
      const flow = page.getByTestId('flowchart');
      await watchHandOver(page);
      const outline = () => page.locator('[data-testid="card-sub-webapi"] svg.sketch path').first().getAttribute('d');
      const before = await outline();
      const card0 = await box(page, 'card-sub-webapi');
      const t0 = Date.now();
      await page.getByTestId('switch-adopt').click();
      // D-360: about six seconds of merge; the outlines move and shrink with their cards, they are not redrawn (VS-25).
      await expect(flow).toHaveAttribute('data-mode', 'merging');
      expect(await outline()).toBe(before);
      await expect(page.getByTestId('opening-lead')).toHaveText("OpenSensorHub covers the data server's subsystems. The rest is written by us, or adopted as libraries.");
      // The Data server card is there to merge into, and the back end starts now, while the cards merge (D-360).
      await expect(page.getByTestId('card-server')).toHaveCount(1);
      await expect.poll(() => workers(page), { timeout: 5_000 }).toBeGreaterThan(0);
      expect(await flow.getAttribute('data-mode')).toBe('merging');
      // The first subsystem travels into the Data server card and shrinks smoothly on the way: sampled mid-flight, its box
      // is between its opening size and its landed size, and away from both its start and its end.
      let sample: Box | null = null;
      for (let i = 0; i < 200 && !sample; i++) {
        const b = await page.getByTestId('card-sub-webapi').boundingBox();
        if (b && b.width < card0.width * 0.9 && b.width > card0.width * 0.4) sample = b;
        else await page.waitForTimeout(15);
      }
      expect(sample, 'a mid-merge sample of the Web API card').not.toBeNull();
      expect(Math.abs(sample!.height / card0.height - sample!.width / card0.width)).toBeLessThan(0.05); // it shrinks as a whole
      expect(sample!.x).not.toBeCloseTo(card0.x, 0);
      // One at a time: each row is ticked as its card lands, in the table's order, all during the merge.
      await expect(page.getByTestId('tick')).toHaveCount(SUBS.length, { timeout: 10_000 });
      expect((await handOverSeen(page)).ticks).toEqual(SUBS.map((_, i) => `${i + 1}@merging`));
      expect(await page.getByTestId('row-sub-webapi').getByTestId('tick').count()).toBe(1);
      for (const id of ['client', 'models', 'importer']) await expect(page.getByTestId(`row-${id}`)).toContainText('Written by us');
      await expect(page.getByTestId('row-scilibs')).toContainText('Adopted');
      // Hand-over: the controls appear when the merge ends (FR-125).
      await expect(page.getByTestId('controls')).toBeVisible({ timeout: 15_000 });
      expect(Date.now() - t0).toBeGreaterThan(5000);
      await expect(flow).toHaveAttribute('data-mode', 'normal');
      // The flowchart was never taken off the page, and the startup page never replaced it (D-360); while the back end was
      // starting after hand-over, its named steps were in the status box, and the controls said why they could not act.
      const seen = await handOverSeen(page);
      expect(seen.gone, 'frames without the flowchart').toBe(0);
      expect(seen.startupPage, 'frames with the startup page').toBe(0);
      expect(seen.flowcharts, 'flowchart elements').toBe(1);
      for (const r of seen.reasons) expect(r).toMatch(/^Starting: /);
      // The opening panel: every subsystem ticked, no number; the switch removed, there is no way back (FR-124, FR-126).
      await expect(page.getByTestId('detail-panel')).toHaveAttribute('data-showing', 'opening');
      await expect(page.getByTestId('tick')).toHaveCount(SUBS.length);
      expect(await page.getByTestId('opening-panel').innerText()).not.toMatch(/\d/);
      await expect(page.getByTestId('opening-switch')).toHaveCount(0);
      // One Data server card, in the third-party zone; the subsystem cards and the opening's lines are gone.
      await expect(page.getByTestId('card-server')).toHaveCount(1);
      for (const id of SUBS) await expect(page.getByTestId(`card-${id}`)).toHaveCount(0);
      await expect(page.getByTestId('opening-lines')).toHaveCount(0);
      // The normal arrows, with their labels, are drawn and fully shown.
      await expect(page.locator('[data-flow]')).toHaveCount(layout.arrows.length);
      expect(await page.getByTestId('flow-arrows').evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
      await expect(page.locator('[data-testid^="flow-label-"]').first()).toBeVisible();
      // Once the server answers, the status box shows its rows (the stand-in is usually ready before the merge ends).
      await expect(flow).toHaveAttribute('data-ready', 'true', { timeout: SLOW });
      await expect(page.getByTestId('startup-strip')).toHaveCount(0);
      await steady(page);
      expect(inside(await box(page, 'card-server'), (await page.locator('[data-zone="third"]').boundingBox())!)).toBe(true);
      // The top-bar controls and the banner appear: the stand-in says so; the Python back end has no such notice (FR-06h).
      for (const id of CONTROLS) await expect(page.getByTestId(id)).toBeVisible();
      if (backend === 'standin') await expect(page.getByTestId('standin-notice')).toBeVisible();
      else await expect(page.getByTestId('standin-notice')).toHaveCount(0);
      // The flowchart is exactly the normal layout: every card where layout.json puts it.
      const origin = (await page.locator('[data-zone="front"]').boundingBox())!;
      const zoom = origin.width / layout.zones[0].rect[2];
      for (const [id, [x, y, w, h]] of Object.entries(layout.cards)) {
        const b = await box(page, `card-${id}`);
        expect(Math.abs((b.x - origin.x) / zoom - x), `${id} x`).toBeLessThan(1);
        expect(Math.abs((b.y - origin.y) / zoom - y), `${id} y`).toBeLessThan(1);
        expect(Math.abs(b.width / zoom - w), `${id} w`).toBeLessThan(1);
        expect(Math.abs(b.height / zoom - h), `${id} h`).toBeLessThan(1);
      }
      await expect(page.locator('[data-flow]')).toHaveCount(layout.arrows.length);

      // AT-65: once started, everything but the detail panel matches a load without the flag.
      await settled(page);
      const other = await browser.newContext({ viewport: { width: 1920, height: 1080 }, baseURL: test.info().project.use.baseURL });
      try {
        const plain = await other.newPage();
        await plain.goto(`demo/?backend=${backend}`);
        await expect(plain.getByTestId('flowchart')).toBeVisible({ timeout: SLOW });
        await settled(plain);
        expect(await view(page)).toEqual(await view(plain));
        await expect(plain.getByTestId('detail-panel')).toHaveAttribute('data-showing', 'none');
      } finally {
        await other.close();
      }

      // AT-67, AT-19: nothing plays before login, an open dataset and Play; every disabled control says why; the client sends nothing.
      await expect(page.getByTestId('analyst-state')).toHaveText('Not logged in');
      await expect(page.getByTestId('dataset-state')).toHaveText('None');
      await expect(page.getByTestId('sim-state')).toHaveText('Paused');
      expect(await everyDisabledControlSaysWhy(page)).toBeGreaterThanOrEqual(6);
      await expect(page.getByTestId('play')).toHaveAttribute('title', 'Log in to the display client first');
      for (const r of ['0.1', '0.5', '1', '10', '100']) await expect(page.getByTestId(`speed-${r}`)).toBeDisabled();
      await page.waitForTimeout(2000);
      expect(log).toEqual([]);
      // The panel keeps the savings until a component is clicked (FR-125); AT-20 from here: nothing gold yet.
      await expect(page.getByTestId('detail-panel')).toHaveAttribute('data-showing', 'opening');
      const gold = () => page.locator('[data-testid^="card-"][data-revealed="true"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')).sort());
      expect(await gold()).toEqual([]);
      for (const c of ['server', 'importer', 'folder', 'scilibs']) {
        await page.getByTestId(`card-${c}`).click();
        await expect(page.getByTestId('detail-title')).not.toContainText('★');
      }
      await expect(page.getByTestId('opening-panel')).toHaveCount(0);
      expect(await gold()).toEqual([]);
      // AT-20: the display client before login is not revealed; Models is, at the first click.
      await page.getByTestId('card-client').click();
      await expect(page.getByTestId('dc-login')).toBeVisible();
      expect(await gold()).toEqual([]);
      await page.getByTestId('card-models').click();
      await expect(page.getByTestId('card-models')).toHaveAttribute('data-revealed', 'true');
      // Login: Mission A open and paused at its start; nothing plays until Play (FR-125a).
      await page.getByTestId('card-client').click();
      await page.getByTestId('demo-login-owner').click();
      await expect(page.getByTestId('chips')).toBeVisible({ timeout: SLOW });
      await expect(page.getByTestId('card-client')).toHaveAttribute('data-revealed', 'true');
      expect(await gold()).toEqual(['card-client', 'card-models']);
      await expect(page.getByTestId('dataset-button')).toContainText(A);
      await expect(page.getByTestId('replay-bar')).toHaveAttribute('data-playing', 'false');
      await expect(page.getByTestId('replay-bar')).toHaveAttribute('data-time', '2031-04-07T00:00:00Z');
      await expect(page.getByTestId('sim-state')).toHaveText('Paused');
      await expect(page.getByTestId('play')).toBeEnabled();
      // AT-19: while paused, the client polls nothing.
      await page.waitForTimeout(2000);
      let t = Date.now();
      await page.waitForTimeout(3000);
      expect(log.filter((x) => x.at >= t)).toEqual([]);
      await expect(page.getByTestId('replay-bar')).toHaveAttribute('data-time', '2031-04-07T00:00:00Z');
      // Play, from the top bar: the replay moves and the client polls.
      await page.getByTestId('play').click();
      await expect(page.getByTestId('sim-state')).toHaveText('Playing');
      await expect(page.getByTestId('replay-bar')).not.toHaveAttribute('data-time', '2031-04-07T00:00:00Z', { timeout: 10_000 });
      t = Date.now();
      await page.waitForTimeout(3000);
      expect(log.filter((x) => x.at >= t).length).toBeGreaterThan(0);
      await page.getByTestId('play').click();
      await expect(page.getByTestId('sim-state')).toHaveText('Paused');
      // AT-19: while locked, nothing is sent.
      await page.getByTestId('dc-lock').click();
      await expect(page.getByTestId('dc-locked')).toBeVisible();
      t = Date.now();
      await page.waitForTimeout(3000);
      expect(log.filter((x) => x.at >= t)).toEqual([]);
      // AT-20: Restart client un-reveals.
      await page.getByTestId('restart-client').click();
      expect(await gold()).toEqual([]);
      expect(errors).toEqual([]);
    });

    test(`AT-65: closing the opening panel after hand-over shows the overview; there is no way back, ${backend}`, async ({ page }) => {
      await openOpening(page);
      await page.getByTestId('switch-adopt').click();
      await expect(page.getByTestId('flowchart')).toHaveAttribute('data-mode', 'normal', { timeout: SLOW });
      await expect(page.getByTestId('detail-panel')).toHaveAttribute('data-showing', 'opening');
      await page.getByTestId('detail-close').click();
      await expect(page.getByTestId('opening-panel')).toHaveCount(0);
      await expect(page.getByTestId('detail-panel')).toHaveAttribute('data-showing', 'none');
      await expect(page.getByTestId('written')).toBeVisible();
      // There is no way back to the opening in this session (FR-126).
      await expect(page.getByTestId('opening-switch')).toHaveCount(0);
      await expect(page.locator('[data-testid^="card-sub-"]')).toHaveCount(0);
    });

    test(`AT-66: with reduced motion, Adopt changes the layout at once, without animation; the overview puts the savings away, ${backend}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openOpening(page);
      // D-361: no illustrative traffic with reduced motion, and the status says only "Opening".
      await page.waitForTimeout(3000);
      await expect(page.getByTestId('mock-icon')).toHaveCount(0);
      await expect(page.getByTestId('status-opening')).toHaveText('Opening');
      await page.evaluate(() => {
        const w = window as unknown as { __modes: string[] };
        w.__modes = [];
        const el = document.querySelector('[data-testid="flowchart"]')!;
        new MutationObserver(() => w.__modes.push(el.getAttribute('data-mode')!)).observe(el, { attributes: true, attributeFilter: ['data-mode'] });
      });
      await watchHandOver(page);
      const t0 = Date.now();
      await page.getByTestId('switch-adopt').click();
      // At once: the controls of the normal startup are there, and the back end is starting.
      await expect(page.getByTestId('controls')).toBeVisible({ timeout: 1000 });
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(await page.evaluate(() => (window as unknown as { __modes: string[] }).__modes)).not.toContain('merging');
      await expect.poll(() => workers(page), { timeout: 30_000 }).toBeGreaterThan(0);
      // Nothing in the page animates (no merge, no fading lines), and the flowchart then shows the normal layout.
      await expect(page.getByTestId('flowchart')).toHaveAttribute('data-mode', 'normal', { timeout: SLOW });
      expect(await page.evaluate(() => document.getAnimations().filter((a) => {
        const t = (a.effect as KeyframeEffect | null)?.target as Element | null;
        return !!t?.closest?.('.flowchart') && !t.closest('.icon');
      }).length)).toBe(0);
      await expect(page.getByTestId('card-server')).toBeVisible();
      await expect(page.getByTestId('tick')).toHaveCount(SUBS.length);
      // The flowchart stays on screen while the back end starts (D-360), its startup in the status box.
      await expect(page.getByTestId('flowchart')).toHaveAttribute('data-ready', 'true', { timeout: SLOW });
      const seen = await handOverSeen(page);
      expect(seen.gone).toBe(0);
      expect(seen.startupPage).toBe(0);
      expect(seen.flowcharts).toBe(1);
      for (const r of seen.reasons) expect(r).toMatch(/^Starting: /);
      // The overview button also puts the savings away (FR-125).
      await expect(page.getByTestId('overview-button')).toBeEnabled();
      await page.getByTestId('overview-button').click();
      await expect(page.getByTestId('opening-panel')).toHaveCount(0);
      await expect(page.getByTestId('written')).toBeVisible();
    });
  });
}

/**
 * D-360: from the Adopt click to a started back end, watch every animation frame: whether the flowchart is on the page,
 * whether the startup page has replaced it, how many flowchart elements there have been, and what the controls said
 * while the status box showed the startup steps.
 */
async function watchHandOver(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __handOver: { gone: number; startupPage: number; els: Set<Element>; reasons: Set<string>; ticks: string[] } };
    w.__handOver = { gone: 0, startupPage: 0, els: new Set(), reasons: new Set(), ticks: [] };
    const loop = () => {
      const h = w.__handOver;
      const fc = document.querySelector('[data-testid="flowchart"]');
      if (fc) h.els.add(fc);
      else h.gone++;
      if (document.querySelector('main.startup')) h.startupPage++;
      const ticks = document.querySelectorAll('[data-testid="tick"]').length;
      if (ticks && h.ticks.length < ticks) h.ticks.push(`${ticks}@${fc?.getAttribute('data-mode')}`);
      const reason = document.querySelector('[data-testid="control-reason"]')?.textContent;
      if (document.querySelector('[data-testid="startup-strip"]') && document.querySelector('[data-testid="controls"]')) h.reasons.add(reason ?? '(none)');
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}
const handOverSeen = (page: Page) => page.evaluate(() => {
  const h = (window as unknown as { __handOver: { gone: number; startupPage: number; els: Set<Element>; reasons: Set<string>; ticks: string[] } }).__handOver;
  return { gone: h.gone, startupPage: h.startupPage, flowcharts: h.els.size, reasons: [...h.reasons], ticks: h.ticks };
});

/** The flowchart at rest: after hand-over it rescales smoothly to the column once the top bar has its controls (D-360). */
async function steady(page: Page) {
  const width = async () => (await page.locator('[data-zone="front"]').boundingBox())?.width ?? 0;
  await expect.poll(async () => {
    const a = await width();
    await page.waitForTimeout(250);
    return Math.abs((await width()) - a);
  }, { timeout: 10_000 }).toBeLessThan(0.01);
}

/** The display client's own requests (its chains are `dc<n>-<seq>`); the models' and the tests' are left out. */
function clientLog(page: Page): { at: number; url: string }[] {
  const log: { at: number; url: string }[] = [];
  page.on('request', (r: Request) => {
    const chain = r.headers()['x-tap-chain'] ?? '';
    if (/\/demo\/api(\/|\?|$)/.test(r.url()) && /^dc\d+-/.test(chain)) log.push({ at: Date.now(), url: r.url() });
  });
  return log;
}

/** AT-67 ("says why"): every disabled top-bar control gives a non-empty reason, in its title and to assistive technology. */
async function everyDisabledControlSaysWhy(page: Page): Promise<number> {
  const found = await page.getByTestId('controls').locator('button').evaluateAll((els) => els.map((e) => {
    const b = e as HTMLButtonElement;
    const ids = (b.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    return { label: b.textContent?.trim() ?? '', disabled: b.disabled, title: b.title,
      described: ids.map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' ') };
  }));
  const disabled = found.filter((c) => c.disabled);
  for (const c of disabled) {
    expect(c.title, `${c.label}: title`).not.toBe('');
    expect(c.described, `${c.label}: aria-describedby`).not.toBe('');
  }
  return disabled.length;
}

/** Started: the server ready and every core model live, so the two pages compared are at rest. */
async function settled(page: Page) {
  await expect(page.getByTestId('server-state')).toHaveText(/^Ready · start 1$/, { timeout: SLOW });
  await expect.poll(async () => page.evaluate(() => {
    const st = (globalThis as any).bargeControlState?.();
    return (st?.models ?? []).filter((m: any) => m.phase === 'live').length;
  }), { timeout: SLOW, intervals: [1000] }).toBe(3);
}

/**
 * What a viewer sees outside the detail panel, for AT-65's comparison: the top bar's text and controls (with whether each
 * can act and why not), the zones, the cards (place, size, name, role, tags, gold), the arrows and their labels, the key,
 * and the status rows. The god's-eye count of messages counted but not drawn is left out: it moves with the models.
 */
async function view(page: Page) {
  return page.evaluate(() => {
    const q = (s: string) => Array.from(document.querySelectorAll(s));
    const r = (e: Element) => {
      const b = e.getBoundingClientRect();
      return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)].join(',');
    };
    const brand = document.querySelector('.topbar .brand') as HTMLElement;
    return {
      brand: brand.innerText,
      controls: q('[data-testid="controls"] button').map((b) => `${b.getAttribute('data-testid')}|${(b as HTMLButtonElement).disabled}|${b.getAttribute('title') ?? ''}|${b.textContent}`),
      zones: q('[data-zone]').map((z) => `${z.getAttribute('data-zone')}@${r(z)}|${(z as HTMLElement).innerText}`),
      cards: q('.card').map((c) => `${c.getAttribute('data-testid')}@${r(c)}|${(c as HTMLElement).innerText}|${c.className}|${c.getAttribute('data-revealed')}`).sort(),
      flows: q('[data-flow]').map((f) => `${f.getAttribute('data-flow')}|${f.textContent}`).sort(),
      key: q('.message-key li').map((l) => (l as HTMLElement).innerText),
      status: q('.status-row').map((s) => (s as HTMLElement).innerText),
      note: (document.querySelector('[data-testid="gods-eye"]') as HTMLElement | null)?.innerText ?? null,
      boxes: q('.panel-box').map((b) => `${b.getAttribute('aria-label')}@${r(b)}`),
    };
  });
}

