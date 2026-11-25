import { expect, Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const readJson = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const layout = readJson('../src/shell/layout.json') as {
  zones: { id: string; rect: Rect }[]; cards: Record<string, Rect>; arrows: { src: string; dst: string; path: number[][] }[];
};
const openingLayout = readJson('../src/shell/layout-opening.json') as {
  cards: Record<string, Rect>; lines: { a: string; b: string; path: number[][] }[];
};

// The adoption opening (SRD §9.8, AT-62 to AT-66), against the assembled site like
// demonstrator.spec.ts. OPENING_BASE sets where the demonstrator is served: 'demo/' on
// the assembled site (the default), '' on a Vite dev server (`npx vite --port 8080`).
const BASE = process.env.OPENING_BASE ?? 'demo/';
const FLAG = `${BASE}?hand-made`;
const SUBS = ['sub-webapi', 'sub-registry', 'sub-obsstore', 'sub-query', 'sub-commands', 'sub-accounts', 'sub-permissions', 'sub-admin'];
/** Written by us either way: in the opening's back-end band beside the eight (FR-120, the gateway of interfaces §9.5). */
const BACK = ['importer', 'replay', 'models', 'gateway'];
const CONTROLS = ['play', 'speed', 'restart-client', 'restart-server', 'demo-menu', 'control-panel-toggle', 'overview-button'];

type Rect = [number, number, number, number];
type Box = { x: number; y: number; width: number; height: number };

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

async function openOpening(page: Page) {
  await countWorkers(page);
  await page.goto(FLAG);
  await expect(page.getByTestId('opening-panel')).toBeVisible();
  await expect(page.getByTestId('flowchart')).toHaveAttribute('data-mode', 'opening');
}

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

test('the fixed layouts: no line crosses a card, no cards overlap (VS-13, FR-120)', () => {
  const normal = layout.arrows.map((a) => ({ id: `${a.src}>${a.dst}`, path: a.path }));
  expect(crossings(layout.cards as Record<string, Rect>, normal)).toEqual([]);
  const lines = openingLayout.lines.map((l) => ({ id: `${l.a}>${l.b}`, path: l.path }));
  expect(crossings(openingLayout.cards as Record<string, Rect>, lines)).toEqual([]);
  for (const cards of [layout.cards, openingLayout.cards] as Record<string, Rect>[]) {
    const list = Object.entries(cards);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, [ax, ay, aw, ah]] = list[i], [b, [bx, by, bw, bh]] = list[j];
        expect(ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah, `${a} overlaps ${b}`).toBe(false);
      }
    }
  }
  // FR-120: two rows of six (with the gateway), every back-end card the same size; no data server.
  const oc = openingLayout.cards as Record<string, Rect>;
  expect(oc.server).toBeUndefined();
  const ids = [...BACK, ...SUBS];
  expect(new Set(ids.map((id) => `${oc[id][2]}x${oc[id][3]}`)).size).toBe(1);
  expect(new Set(ids.map((id) => oc[id][1])).size).toBe(2);
  // ...and the same size as the importer, replay controller, gateway and Models in the normal layout.
  for (const id of BACK) expect((layout.cards as Record<string, Rect>)[id].slice(2)).toEqual(oc[id].slice(2));
});

test('AT-62: without the flag the normal startup; with it the opening; a reload repeats it', async ({ page }) => {
  await countWorkers(page);
  await page.goto(BASE);
  // FR-77: the back end starts at once (its worker is created) and no opening is shown.
  await expect.poll(() => workers(page), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(page.getByTestId('opening-panel')).toHaveCount(0);
  await expect(page.getByTestId('card-sub-webapi')).toHaveCount(0);

  await page.goto(FLAG);
  await expect(page.getByTestId('opening-panel')).toBeVisible();
  await expect(page.getByTestId('switch-build')).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await expect(page.getByTestId('opening-panel')).toBeVisible();
  await expect(page.getByTestId('flowchart')).toHaveAttribute('data-mode', 'opening');
  // Any value, or none, is the flag (FR-119).
  await page.goto(`${BASE}?hand-made=yes`);
  await expect(page.getByTestId('opening-panel')).toBeVisible();
});

test('AT-63: nothing runs, nothing is gold, and clicks reveal nothing in the opening', async ({ page }) => {
  const api: string[] = [];
  page.on('request', (r) => /\/api\//.test(r.url()) && api.push(r.url()));
  await openOpening(page);
  // FR-122: no top-bar control and no stand-in banner in the page; only the title.
  for (const id of CONTROLS) await expect(page.getByTestId(id)).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Controls' })).toHaveCount(0);
  await expect(page.getByTestId('standin-notice')).toHaveCount(0);
  await expect(page.getByTestId('demo-banner')).toHaveCount(0);
  expect(await page.locator('.topbar').innerText()).toBe('Canal barge weather demonstrator');
  await expect(page.locator('body')).not.toContainText('JavaScript stand-in');
  // The status shows only "Opening".
  expect((await page.getByTestId('status-box').innerText()).replace(/\s+/g, ' ').trim()).toBe('Status Opening');
  // No worker, no relay, no request, no message.
  await page.waitForTimeout(3000);
  expect(await workers(page)).toBe(0);
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  expect(api).toEqual([]);
  await expect(page.getByTestId('message-icon')).toHaveCount(0);
  await expect(page.locator('.flowchart [data-letter]')).toHaveCount(0);
  await expect(page.locator('.opening-lines text')).toHaveCount(0); // plain lines, no letters (FR-120a)
  // No data server, and the third-party zone holds the scientific libraries only.
  await expect(page.getByTestId('card-server')).toHaveCount(0);
  const third = (await page.locator('[data-zone="third"]').boundingBox())!;
  const inThird: string[] = [];
  for (const c of await page.locator('.card').all()) if (inside((await c.boundingBox())!, third)) inThird.push((await c.getAttribute('data-testid'))!);
  expect(inThird).toEqual(['card-scilibs']);
  // FR-121: nothing gold, no ★, no diamond, no "value-add", anywhere.
  const noGold = async () => {
    await expect(page.locator('.gold, [data-revealed="true"], .va-pill')).toHaveCount(0);
    await expect(page.getByTestId('diamond')).toHaveCount(0);
    const text = await page.locator('body').innerText();
    expect(text).not.toContain('★');
    expect(text.toLowerCase()).not.toContain('value-add');
  };
  await noGold();
  // Clicking the display client or Models reveals nothing and changes nothing (FR-121, FR-123).
  for (const id of ['client', 'models', 'importer', 'gateway', 'scilibs', 'folder']) {
    await page.getByTestId(`card-${id}`).click();
    await expect(page.getByTestId('detail-panel')).toHaveAttribute('data-showing', 'opening');
    await expect(page.locator('.opening-table tr.highlighted')).toHaveCount(0);
  }
  await noGold();
  // Clicking a subsystem card highlights its row (FR-123).
  await page.getByTestId('card-sub-obsstore').click();
  await expect(page.getByTestId('row-sub-obsstore')).toHaveClass(/highlighted/);
  await page.getByTestId('card-sub-accounts').click();
  await expect(page.getByTestId('row-sub-accounts')).toHaveClass(/highlighted/);
  await expect(page.locator('.opening-table tr.highlighted')).toHaveCount(1);
  // "Written by us either way", in plain style.
  await expect(page.getByTestId('written-either-way')).toHaveText(/CSV importer.*Replay controller.*Access gateway.*Models.*Display client/s);
  await noGold();
});

test('AT-64: the eight subsystem cards are the equals of the importer, replay controller, gateway and Models', async ({ page }) => {
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
  // Two rows of six on one grid (FR-120, with the gateway).
  const rows = new Map<number, number>();
  for (const b of boxes) rows.set(Math.round(b.y), (rows.get(Math.round(b.y)) ?? 0) + 1);
  expect([...rows.values()].sort()).toEqual([6, 6]);
  // The same card style: fill, font, outline (VS-25).
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
  for (const id of ids) expect(await style(id), id).toBe(ref);
  // No element encloses or labels the eight as a group: anything around all eight is also around the other three.
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
});

test('AT-65: Adopt merges the eight into one Data server card and hands over', async ({ page }) => {
  await openOpening(page);
  const flow = page.getByTestId('flowchart');
  const outline = () => page.locator('[data-testid="card-sub-webapi"] svg.sketch path').first().getAttribute('d');
  const before = await outline();
  const t0 = Date.now();
  await page.getByTestId('switch-adopt').click();
  // About 1.5 s of merge; the outlines move, not redrawn (VS-25).
  await expect(flow).toHaveAttribute('data-mode', 'merging');
  expect(await outline()).toBe(before);
  await expect(page.getByTestId('opening-table')).toContainText('Web API');
  await expect(page.getByTestId('opening-lead')).toHaveText('OpenSensorHub covers all of these.');
  await expect(flow).toHaveAttribute('data-mode', 'normal', { timeout: 5000 });
  const took = Date.now() - t0;
  expect(took).toBeGreaterThan(1200);
  // One Data server card, in the third-party zone; the eight are gone.
  await expect(page.getByTestId('card-server')).toHaveCount(1);
  for (const id of SUBS) await expect(page.getByTestId(`card-${id}`)).toHaveCount(0);
  expect(inside(await box(page, 'card-server'), (await page.locator('[data-zone="third"]').boundingBox())!)).toBe(true);
  // Every subsystem ticked, and no number anywhere in the panel (FR-124, §16).
  await expect(page.getByTestId('tick')).toHaveCount(8);
  expect(await page.getByTestId('opening-panel').innerText()).not.toMatch(/\d/);
  // The switch is removed; there is no way back (FR-126).
  await expect(page.getByTestId('opening-switch')).toHaveCount(0);
  // The top-bar controls and the banner appear, and the back end starts (FR-125).
  for (const id of CONTROLS) await expect(page.getByTestId(id)).toBeVisible();
  await expect(page.getByTestId('standin-notice')).toBeVisible(); // the stand-in is the default back end (FR-06b)
  await expect.poll(() => workers(page), { timeout: 30_000 }).toBeGreaterThan(0);
  // The flowchart is exactly the normal layout: every card where layout.json puts it.
  const origin = await page.locator('[data-zone="front"]').boundingBox();
  const zoom = origin!.width / layout.zones[0].rect[2];
  for (const [id, [x, y, w, h]] of Object.entries(layout.cards as Record<string, Rect>)) {
    const b = await box(page, `card-${id}`);
    expect(Math.abs((b.x - origin!.x) / zoom - x), `${id} x`).toBeLessThan(1);
    expect(Math.abs((b.y - origin!.y) / zoom - y), `${id} y`).toBeLessThan(1);
    expect(Math.abs(b.width / zoom - w), `${id} w`).toBeLessThan(1);
    expect(Math.abs(b.height / zoom - h), `${id} h`).toBeLessThan(1);
  }
  await expect(page.locator('[data-flow]')).toHaveCount(layout.arrows.length);
  await expect(page.getByTestId('opening-lines')).toHaveCount(0);
  // The panel keeps the savings until a component is clicked (FR-125).
  await expect(page.getByTestId('detail-panel')).toHaveAttribute('data-showing', 'opening');
  await page.getByTestId('card-scilibs').click();
  await expect(page.getByTestId('detail-panel')).toHaveAttribute('data-showing', 'scilibs');
  await page.getByTestId('detail-close').click();
  await expect(page.getByTestId('overview')).toBeVisible();
});

test('AT-65: closing the opening panel after hand-over shows the overview', async ({ page }) => {
  await openOpening(page);
  await page.getByTestId('switch-adopt').click();
  await expect(page.getByTestId('flowchart')).toHaveAttribute('data-mode', 'normal', { timeout: 5000 });
  await page.getByTestId('detail-close').click();
  await expect(page.getByTestId('opening-panel')).toHaveCount(0);
  await expect(page.getByTestId('overview')).toBeVisible();
});

test('AT-66: with reduced motion, Adopt changes the layout at once', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openOpening(page);
  await page.evaluate(() => {
    const w = window as unknown as { __modes: string[] };
    w.__modes = [];
    const el = document.querySelector('[data-testid="flowchart"]')!;
    new MutationObserver(() => w.__modes.push(el.getAttribute('data-mode')!)).observe(el, { attributes: true, attributeFilter: ['data-mode'] });
  });
  const t0 = Date.now();
  await page.getByTestId('switch-adopt').click();
  await expect(page.getByTestId('card-server')).toBeVisible();
  await expect(page.getByTestId('flowchart')).toHaveAttribute('data-mode', 'normal');
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(await page.evaluate(() => (window as unknown as { __modes: string[] }).__modes)).not.toContain('merging');
  await expect(page.getByTestId('tick')).toHaveCount(8);
});
