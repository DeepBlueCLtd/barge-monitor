// NFR-04: TypeScript types generated from the committed masters.
import { compileFromFile } from 'json-schema-to-typescript';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const contracts = join(here, '..', '..', 'contracts');
const out = join(here, '..', 'src', 'generated');
mkdirSync(out, { recursive: true });
const files = [join(contracts, 'profile.schema.json'), ...readdirSync(join(contracts, 'schemas')).map((f) => join(contracts, 'schemas', f))];
let ts = '/* Generated from contracts/ by scripts/gen-schema-types.mjs. Do not edit. */\n';
for (const f of files) {
  ts += await compileFromFile(f, { bannerComment: '', cwd: join(contracts, 'schemas'), declareExternallyReferenced: true, additionalProperties: false });
}
// json-schema-to-typescript repeats shared definitions once per file.
const seen = new Set();
ts = ts.split(/\n(?=export )/).filter((block) => {
  const m = block.match(/^export (?:interface|type) (\w+)/);
  if (!m) return true;
  if (seen.has(m[1])) return false;
  seen.add(m[1]);
  return true;
}).join('\n');
writeFileSync(join(out, 'schemas.d.ts'), ts);
console.log(`wrote src/generated/schemas.d.ts (${seen.size} types)`);
