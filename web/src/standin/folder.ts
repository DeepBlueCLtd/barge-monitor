// The data folder (C-02, FR-17, FR-17a): read-only. The importer is the only
// reader. In the browser the folder is a directory of the site, listed by its
// index.json and read file by file (each `<file>.gz`); in Node it is a local
// directory (web/scripts/standin-server.mjs). Nothing here writes.

export interface FolderEntry {
  file: string;
  size: number; // bytes of the CSV, uncompressed
  modified: string; // ISO
  sha256: string;
}

export interface Folder {
  list(): Promise<FolderEntry[]>;
  read(file: string): Promise<Uint8Array>;
}

/** The folder in the browser: `<base>index.json` and `<base><file>.gz`, decompressed as they arrive. */
export function fetchFolder(base: string): Folder {
  const root = base.endsWith('/') ? base : base + '/';
  return {
    async list() {
      const r = await fetch(root + 'index.json', { cache: 'no-cache', signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`the data folder has no listing (HTTP ${r.status})`);
      const j = await r.json();
      return (j.files ?? []) as FolderEntry[];
    },
    async read(file: string) {
      const r = await fetch(root + encodeURIComponent(file) + '.gz', { signal: AbortSignal.timeout(120_000) });
      if (!r.ok || !r.body) throw new Error(`${file}: HTTP ${r.status}`);
      const s = r.body.pipeThrough(new DecompressionStream('gzip'));
      return new Uint8Array(await new Response(s).arrayBuffer());
    },
  };
}
