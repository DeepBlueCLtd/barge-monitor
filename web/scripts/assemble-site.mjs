// Assemble a local site laid out as GitHub Pages serves it:
//   <out>/demo/                 the demonstrator (web/dist)
//   <out>/demo/data/folder/     the data folder (FR-15), built by scripts/build_data_folder.py
//   <out>/pyodide/<version>/    Pyodide and its packages, same origin (NFR-06)
// Usage: node scripts/assemble-site.mjs [out] [--no-pyodide]
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.29.5';
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? join(here, '..', '..', 'dist-site'));
const dist = join(here, '..', 'dist');
if (!existsSync(dist)) throw new Error('build the web app first: npm run build');
rmSync(join(out, 'demo'), { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(dist, join(out, 'demo'), { recursive: true });
const folder = join(here, '..', 'public', 'data', 'folder');
if (!existsSync(join(folder, 'index.json'))) throw new Error('build the data folder first: python scripts/build_data_folder.py');
cpSync(folder, join(out, 'demo', 'data', 'folder'), { recursive: true });
if (!process.argv.includes('--no-pyodide')) {
  const cache = join(here, '..', '..', '.cache', 'pyodide', VERSION);
  if (!existsSync(cache)) throw new Error('fetch Pyodide first: npm run pyodide');
  cpSync(cache, join(out, 'pyodide', VERSION), { recursive: true });
}
console.log(`site assembled in ${out}`);
