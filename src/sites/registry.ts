import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadSiteConfigs } from './configLoader.js';
import type { SiteMeta } from './configSchema.js';
import type { SiteAdapter } from './types.js';

/** Name -> adapter lookup, with optional config metadata for tag filtering and triage. */
export class AdapterRegistry {
  private readonly adapters = new Map<string, SiteAdapter>();
  private readonly meta = new Map<string, SiteMeta>();

  register(adapter: SiteAdapter, siteMeta?: SiteMeta): void {
    if (this.adapters.has(adapter.name)) throw new Error(`Duplicate site adapter: ${adapter.name}`);
    this.adapters.set(adapter.name, adapter);
    if (siteMeta) this.meta.set(adapter.name, siteMeta);
  }
  get(name: string): SiteAdapter | undefined {
    return this.adapters.get(name);
  }
  getMeta(name: string): SiteMeta | undefined {
    return this.meta.get(name);
  }
  list(): SiteAdapter[] {
    return [...this.adapters.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  listByTag(tag: string): SiteAdapter[] {
    return this.list().filter((a) => this.meta.get(a.name)?.tags.includes(tag));
  }
}

const isAdapter = (v: unknown): v is SiteAdapter =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as SiteAdapter).name === 'string' &&
  typeof (v as SiteAdapter).discover === 'function';

/**
 * Auto-discover custom `.ts`/`.js` adapters in `dir` and declarative `.json` site configs
 * in `configDir` (defaults to `<cwd>/sites` when `dir` is omitted).
 */
export async function loadRegistry(
  dir: string = path.dirname(fileURLToPath(import.meta.url)),
  opts: { configDir?: string | false } = {},
): Promise<AdapterRegistry> {
  const registry = new AdapterRegistry();
  const skip = new Set(['types', 'registry', 'configSchema', 'configLoader']);
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|js|mjs)$/.test(e.name) && !e.name.endsWith('.d.ts'))
    .map((e) => e.name)
    .filter((n) => !n.startsWith('_') && !skip.has(n.replace(/\.(ts|js|mjs)$/, '')))
    .sort();
  for (const file of files) {
    const mod = (await import(pathToFileURL(path.join(dir, file)).href)) as { default?: unknown };
    const exported = Array.isArray(mod.default) ? mod.default : [mod.default];
    for (const a of exported) {
      if (!isAdapter(a)) throw new Error(`${file}: default export is not a SiteAdapter`);
      registry.register(a);
    }
  }

  const configDir =
    opts.configDir === false ? undefined : (opts.configDir ?? path.resolve(process.cwd(), 'sites'));
  if (configDir) {
    const { adapters, meta } = loadSiteConfigs(configDir);
    for (const adapter of adapters) {
      registry.register(adapter, meta.get(adapter.name));
    }
  }

  return registry;
}
