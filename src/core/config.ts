import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : /^(1|true|yes)$/i.test(v)));

/** Per-site tunables. Every field can be overridden by an adapter's `config`. */
export const SiteConfigSchema = z.object({
  concurrency: z.number().int().min(1).default(2),
  /** Rate limiter: min/max delay (ms) between operations; jittered uniformly. */
  minDelayMs: z.number().int().min(0).default(500),
  maxDelayMs: z.number().int().min(0).default(1500),
  headless: bool.default(true),
  blockResources: z.array(z.enum(['image', 'font', 'media', 'stylesheet'])).default([]),
  retries: z.number().int().min(0).default(3),
  retryMinTimeoutMs: z.number().int().min(0).default(1000),
  retryMaxTimeoutMs: z.number().int().min(0).default(30_000),
  navigationTimeoutMs: z.number().int().min(1000).default(30_000),
  downloadTimeoutMs: z.number().int().min(1000).default(120_000),
  maxFileSizeBytes: z
    .number()
    .int()
    .positive()
    .default(500 * 1024 * 1024),
  zip: z
    .object({
      maxTotalBytes: z
        .number()
        .int()
        .positive()
        .default(1024 * 1024 * 1024),
      maxEntries: z.number().int().positive().default(5000),
      maxRatio: z.number().positive().default(100),
      maxDepth: z.number().int().min(0).default(2),
    })
    .default({ maxTotalBytes: 1024 * 1024 * 1024, maxEntries: 5000, maxRatio: 100, maxDepth: 2 }),
  trace: bool.default(false),
  fingerprint: bool.default(true),
});
export type SiteConfig = z.infer<typeof SiteConfigSchema>;

export const GlobalConfigSchema = z.object({
  logLevel: z.string().default('info'),
  dataDir: z.string().default('data'),
  sessionsDir: z.string().default('sessions'),
  dbPath: z.string().optional(),
  site: SiteConfigSchema.default(() => SiteConfigSchema.parse({})),
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema> & { dbPath: string };

/** Load global config from environment variables (and `.env`). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GlobalConfig {
  const parsed = GlobalConfigSchema.parse({
    logLevel: env.LOG_LEVEL,
    dataDir: env.DATA_DIR,
    sessionsDir: env.SESSIONS_DIR,
    dbPath: env.DB_PATH,
    site: {
      ...(env.HEADLESS !== undefined && { headless: env.HEADLESS }),
      ...(env.TRACE !== undefined && { trace: env.TRACE }),
      ...(env.FINGERPRINT !== undefined && { fingerprint: env.FINGERPRINT }),
    },
  });
  return { ...parsed, dbPath: parsed.dbPath ?? `${parsed.dataDir}/manifest.sqlite` };
}

/** Merge an adapter's partial overrides onto the global site defaults (deep for `zip`). */
export function resolveSiteConfig(
  base: SiteConfig,
  override: Partial<SiteConfig> = {},
): SiteConfig {
  return SiteConfigSchema.parse({
    ...base,
    ...override,
    zip: { ...base.zip, ...(override.zip ?? {}) },
  });
}
