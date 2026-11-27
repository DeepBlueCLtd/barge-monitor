import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { expect, Page, test } from '@playwright/test';
import { DATA_FOLDER_BUDGET_BYTES, DOWNLOAD_BUDGET_BYTES, STARTUP_BUDGET_MS } from '../src/budgets';
import { PORT } from './site';
import { runSuiteInPyodide } from './suite-in-pyodide';

// Phase 10, hardening (plan-v4.7 §3): Python in a real browser, in both back ends.
//
// * NFR-10: the startup budget, from navigation until every step is done and the flowchart is shown (the
//   models included, NFR-05), from a cold cache, and the download size of a start and of the data folder,
//   declared in src/config.ts and measured here for each back end (D-340).
// * AT-02, Pyodide half: the server-neutral contract suite, run in Pyodide against each back end in the page
//   (the CPython half is tests/test_contract_uvicorn.py; the stand-in in Node, tests/test_contract_standin.py).
//
// The site is served here by a counting copy of scripts/serve.mjs, so every byte the page and its workers fetch
// is counted, whatever answers it (Playwright does not see every worker's requests).
const SITE = resolve(new URL('../../dist-site', import.meta.url).pathname);
const COUNT_PORT = PORT + 2;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.zip': 'application/zip', '.whl': 'application/zip',
  '.svg': 'image/svg+xml', '.map': 'application/json', '.tar': 'application/x-tar', '.gz': 'application/gzip',
};
const served = new Map<string, number>();
let server: Server;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let f = join(SITE, normalize(decodeURIComponent(url.pathname)));
    if (!f.startsWith(SITE)) { res.writeHead(403).end(); return; }
    if (existsSync(f) && statSync(f).isDirectory()) {
      if (!url.pathname.endsWith('/')) { res.writeHead(301, { location: url.pathname + '/' + url.search }).end(); return; }
      f = join(f, 'index.html');
    }
    if (!existsSync(f)) { res.writeHead(404).end('not found'); return; }
    const size = statSync(f).size;
    served.set(url.pathname, (served.get(url.pathname) ?? 0) + size);
    // As GitHub Pages serves the site: cacheable for ten minutes, so a reload is measured as a visitor's second load.
    res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream', 'content-length': String(size),
      'cache-control': 'max-age=600', 'last-modified': statSync(f).mtime.toUTCString() });
    createReadStream(f).pipe(res);
  });
  await new Promise<void>((r) => server.listen(COUNT_PORT, r));
});
test.afterAll(async () => new Promise<void>((r) => server.close(() => r())));

const MB = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

/**
 * Every core model live: registered, subscribed and done processing Mission A, which is when the startup step
 * "models" is done in this build (NFR-05). ms since navigation, in the page's own clock. On the way, when each core
 * model was first ready (registered and subscribed: processing or live) is noted too, for the record (D-340).
 */
async function modelsLive(page: Page, timeout: number): Promise<{ live: number; ready: number | null }> {
  const h = await page.waitForFunction(() => {
    const g = globalThis as any;
    const ms = (g.bargeControlState?.()?.models ?? []) as { id: string; phase: string }[];
    g.bargeReadyAt ??= {};
    for (const m of ms) if ((m.phase === 'processing' || m.phase === 'live') && g.bargeReadyAt[m.id] == null) g.bargeReadyAt[m.id] = performance.now();
    if (ms.filter((m) => m.phase === 'live').length !== 3) return false;
    const r = Object.values(g.bargeReadyAt) as number[];
    return { live: Math.round(performance.now()), ready: r.length === 3 ? Math.round(Math.max(...r)) : null };
  }, null, { timeout, polling: 100 });
  return (await h.jsonValue()) as { live: number; ready: number | null };
}

/** Record, from the first instant, when each startup step is done and when the flowchart appears. */
async function watchSteps(page: Page) {
  await page.addInitScript(() => {
    const t: Record<string, number> = {};
    (globalThis as any).bargeStartupTimes = t;
    const look = () => {
      for (const el of Array.from(document.querySelectorAll('[data-testid^="step-"]'))) {
        const id = el.getAttribute('data-testid')!.slice(5);
        if (el.getAttribute('data-state') === 'done' && t[id] == null) t[id] = performance.now();
      }
      if (t.flowchart == null && document.querySelector('[data-testid="flowchart"]')) t.flowchart = performance.now();
    };
    new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] });
  });
}

for (const backend of ['standin', 'python'] as const) {
  const name = backend === 'python' ? 'Python in Pyodide' : 'JavaScript stand-in';

  test(`NFR-10: a cold start completes within ${STARTUP_BUDGET_MS / 1000} s, models included, and downloads within its budget, ${backend}`, async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await watchSteps(page);
    served.clear();
    const t0 = Date.now();
    await page.goto(`http://localhost:${COUNT_PORT}/demo/?backend=${backend}`);
    // Measured, then judged: the wait is twice the budget, so a miss is measured, not cut short.
    await expect(page.getByTestId('flowchart')).toBeVisible({ timeout: STARTUP_BUDGET_MS * 2 });
    const { live: started, ready } = await modelsLive(page, STARTUP_BUDGET_MS * 2);
    const wall = Date.now() - t0;
    const times = await page.evaluate(() => (globalThis as any).bargeStartupTimes as Record<string, number>);
    await page.waitForTimeout(2000); // let late fetches (a model's packages, say) finish before counting
    const bytes = [...served.values()].reduce((a, b) => a + b, 0);
    const folder = [...served].filter(([p]) => p.includes('/data/folder/')).reduce((a, [, b]) => a + b, 0);
    const top = [...served].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p, b]) => `${MB(b)} ${p.replace(/^.*\//, '')}`);
    console.log(`${name}: startup ${started} ms from navigation to every core model live, Mission A processed (${wall} ms by the test's clock; each core model ready, registered and subscribed, by ${ready} ms; steps done, ms: ${Object.entries(times).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ')}); ` +
      `downloaded ${MB(bytes)} (data folder ${MB(folder)}); largest: ${top.join('; ')}`);
    expect(started, `${name}: startup took ${started} ms`).toBeLessThanOrEqual(STARTUP_BUDGET_MS);
    expect(bytes, `${name}: a start downloaded ${MB(bytes)}`).toBeLessThanOrEqual(DOWNLOAD_BUDGET_BYTES[backend]);
    // A second load in the same browser (the relay installed, the files cached) is a startup too: measured and judged.
    const t1 = Date.now();
    served.clear();
    await page.reload();
    await expect(page.getByTestId('flowchart')).toBeVisible({ timeout: STARTUP_BUDGET_MS * 2 });
    await modelsLive(page, STARTUP_BUDGET_MS * 2);
    const again = Date.now() - t1;
    console.log(`${name}: reload ${again} ms, ${MB([...served.values()].reduce((a, b) => a + b, 0))} served`);
    expect(again).toBeLessThanOrEqual(STARTUP_BUDGET_MS);
    await context.close();
  });

  test(`AT-02: the contract suite, in Pyodide in the browser, passes against the back end in the page, ${backend}`, async ({ browser }) => {
    test.setTimeout(300_000);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`demo/?backend=${backend}`);
    await expect(page.getByTestId('flowchart')).toBeVisible({ timeout: STARTUP_BUDGET_MS });
    await modelsLive(page, STARTUP_BUDGET_MS); // the models' resources exist, as in the CPython half (D-285)
    const t0 = Date.now();
    const results = await runSuiteInPyodide(page);
    console.log(`${name}: the suite ran in Pyodide in ${Date.now() - t0} ms`);
    for (const r of results) console.log(`  ${r.outcome.toUpperCase()} ${r.group} ${r.name}${r.detail ? ' -- ' + r.detail.split('\n')[0] : ''}`);
    expect(results.filter((r) => r.group === 'need').length).toBeGreaterThanOrEqual(14);
    expect(results.filter((r) => r.group === 'standin').length).toBeGreaterThanOrEqual(8);
    expect(results.filter((r) => r.outcome !== 'passed').map((r) => `${r.group} ${r.name}: ${r.detail.split('\n')[0]}`)).toEqual([]);
    await context.close();
  });
}

test('NFR-10: the data folder the site ships is within its declared download size', async () => {
  const dir = join(SITE, 'demo', 'data', 'folder');
  const files = readdirSync(dir).map((f) => [f, statSync(join(dir, f)).size] as const);
  const total = files.reduce((a, [, b]) => a + b, 0);
  console.log(`data folder: ${MB(total)} in ${files.length} files: ${files.map(([f, b]) => `${f} ${MB(b)}`).join(', ')}`);
  expect(total).toBeLessThanOrEqual(DATA_FOLDER_BUDGET_BYTES);
});
