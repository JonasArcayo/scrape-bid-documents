import fs from 'node:fs';
import path from 'node:path';
import { JsonSiteConfigSchema, type SiteMeta } from './configSchema.js';
import { buildBidlockerAdapter } from './templates/bidlocker.js';
import { buildFirecrawlAdapter } from './templates/firecrawl.js';
import { buildTemplateAdapter } from './templates/generic.js';
import type { SiteAdapter } from './types.js';

export interface LoadedConfigs {
  adapters: SiteAdapter[];
  meta: Map<string, SiteMeta>;
}

function walkJsonFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkJsonFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      results.push(full);
    }
  }
  return results.sort();
}

/**
 * Load and validate all declarative `.json` site configs under `configDir`.
 * Files/directories starting with `_` (e.g. `_schema.json`, `_disabled/`) are ignored.
 */
export function loadSiteConfigs(configDir: string): LoadedConfigs {
  const adapters: SiteAdapter[] = [];
  const meta = new Map<string, SiteMeta>();

  for (const file of walkJsonFiles(configDir)) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Invalid JSON in site config ${file}: ${(err as Error).message}`, {
        cause: err,
      });
    }

    const parsed = JsonSiteConfigSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      throw new Error(`Invalid site config ${file}: ${issues}`);
    }

    const cfg = parsed.data;
    if (!cfg.enabled) continue;

    const adapter =
      cfg.template === 'bidlocker'
        ? buildBidlockerAdapter(cfg)
        : cfg.template === 'firecrawl'
          ? buildFirecrawlAdapter(cfg)
          : buildTemplateAdapter(cfg);
    adapters.push(adapter);
    meta.set(cfg.name, {
      tags: cfg.tags,
      template: cfg.template,
      configPath: file,
    });
  }

  return { adapters, meta };
}
