import { z } from 'zod';
import { SiteConfigSchema } from '../core/config.js';

const SelectorChain = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

export type SelectorInput = z.infer<typeof SelectorChain>;

/** Normalize a single selector or fallback array into a non-empty array. */
export const toSelectorList = (s: SelectorInput): string[] => (Array.isArray(s) ? s : [s]);

const BaseFields = {
  $schema: z.string().optional(),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  tags: z.array(z.string().min(1)).default([]),
  config: SiteConfigSchema.partial().optional(),
};

const UrlFilterSchema = z
  .object({
    include: z.string().min(1).optional(),
    exclude: z.string().min(1).optional(),
  })
  .optional();

const LinkListSchema = z.object({
  ...BaseFields,
  template: z.literal('link-list'),
  urls: z.array(z.string().url()).min(1),
  selectors: z.object({
    ready: SelectorChain.optional(),
    row: SelectorChain.optional(),
    link: SelectorChain,
    nextPage: SelectorChain.optional(),
  }),
  urlFilter: UrlFilterSchema,
  maxPages: z.number().int().min(1).default(50),
});

const TableLinksSchema = z.object({
  ...BaseFields,
  template: z.literal('table-links'),
  urls: z.array(z.string().url()).min(1),
  selectors: z.object({
    ready: SelectorChain.optional(),
    row: SelectorChain,
    link: SelectorChain,
    nextPage: SelectorChain.optional(),
  }),
  urlFilter: UrlFilterSchema,
  maxPages: z.number().int().min(1).default(50),
});

const TableDetailSchema = z.object({
  ...BaseFields,
  template: z.literal('table-detail'),
  urls: z.array(z.string().url()).min(1),
  selectors: z.object({
    ready: SelectorChain.optional(),
    row: SelectorChain.optional(),
    detailLink: SelectorChain,
    hopLink: SelectorChain.optional(),
    detailReady: SelectorChain.optional(),
    docLink: SelectorChain,
    nextPage: SelectorChain.optional(),
  }),
  downloadMode: z.enum(['url', 'click']).default('url'),
  pageSettleMs: z.number().int().min(0).default(300),
  urlFilter: UrlFilterSchema,
  maxPages: z.number().int().min(1).default(50),
});

const BidlockerSchema = z.object({
  ...BaseFields,
  template: z.literal('bidlocker'),
  agency: z.string().min(1),
});

const FirecrawlSchema = z.object({
  ...BaseFields,
  template: z.literal('firecrawl'),
  urls: z.array(z.string().url()).min(1),
  mode: z.enum(['scrape', 'map']).default('scrape'),
  includeLinks: z.string().min(1).optional(),
  excludeLinks: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(5000).default(100),
  onlyMainContent: z.boolean().default(true),
  waitForMs: z.number().int().min(0).default(0),
});

export const JsonSiteConfigSchema = z.discriminatedUnion('template', [
  LinkListSchema,
  TableLinksSchema,
  TableDetailSchema,
  BidlockerSchema,
  FirecrawlSchema,
]);

export type JsonSiteConfig = z.infer<typeof JsonSiteConfigSchema>;
export type GenericTemplateConfig =
  | z.infer<typeof LinkListSchema>
  | z.infer<typeof TableLinksSchema>
  | z.infer<typeof TableDetailSchema>;
export type BidlockerSiteConfig = z.infer<typeof BidlockerSchema>;
export type FirecrawlSiteConfig = z.infer<typeof FirecrawlSchema>;

export interface SiteMeta {
  tags: string[];
  template: string;
  configPath?: string;
}
