// Fetch Pyodide and the Python packages the demonstrator uses, once, into
// .cache/pyodide/<version>/. The site then serves them itself (NFR-06): no
// request at run time goes to a third-party CDN.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PYODIDE_VERSION = '0.29.5';
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', '.cache', 'pyodide', PYODIDE_VERSION);
const cdn = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const CORE = ['pyodide.mjs', 'pyodide.js', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
// Backend: numpy. Workspace: the analyst's libraries (FR-30) and jsonschema
// for the contract suite (AT-02).
const WANTED = ['numpy', 'pandas', 'scipy', 'scikit-learn', 'jsonschema'];

mkdirSync(out, { recursive: true });

async function get(name) {
  const dest = join(out, name);
  if (existsSync(dest)) return readFileSync(dest);
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(cdn + name);
      if (!r.ok) throw new Error(`${r.status} ${name}`);
      const buf = Buffer.from(await r.arrayBuffer());
      writeFileSync(dest, buf);
      return buf;
    } catch (e) {
      if (attempt === 4) throw e;
      await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
    }
  }
}

for (const f of CORE) await get(f);
const lock = JSON.parse(readFileSync(join(out, 'pyodide-lock.json'), 'utf8'));
const need = new Set();
const visit = (n) => {
  const key = n.toLowerCase().replace(/_/g, '-');
  const pkg = lock.packages[key];
  if (!pkg) throw new Error(`package ${n} not in lock file`);
  if (need.has(key)) return;
  need.add(key);
  pkg.depends.forEach(visit);
};
WANTED.forEach(visit);
let bytes = 0;
for (const key of [...need].sort()) {
  const pkg = lock.packages[key];
  const buf = await get(pkg.file_name);
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== pkg.sha256) throw new Error(`checksum mismatch for ${pkg.file_name}`);
  bytes += buf.length;
}
console.log(`pyodide ${PYODIDE_VERSION}: ${need.size} packages, ${(bytes / 1e6).toFixed(1)} MB, in ${out}`);
