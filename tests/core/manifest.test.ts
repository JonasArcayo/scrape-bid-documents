import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Manifest } from '../../src/core/manifest.js';

const mk = () => new Manifest(':memory:');
const base = { url: null, title: null, sourcePageUrl: null };

describe('Manifest', () => {
  it('upsert is idempotent per (site, key) and namespaced by site', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (a, key) => {
        fc.pre(a !== 'other');
        const m = mk();
        const r1 = m.upsert('s', key, base);
        const r2 = m.upsert('s', key, { ...base, title: 't' });
        const r3 = m.upsert('other', key, base);
        expect(r2.id).toBe(r1.id);
        expect(r3.id).not.toBe(r1.id);
        expect(m.find('s', key)?.title).toBe('t');
        m.close();
      }),
    );
  });

  it('dedups globally by sha256, ignoring duplicate rows', () => {
    const m = mk();
    const a = m.upsert('a', 'k1', base);
    m.recordDownload(a.id, { sha256: 'h1', size: 5, type: 'pdf', storageKey: 'a/x.pdf' });
    expect(m.findBySha('h1')?.id).toBe(a.id);
    const b = m.upsert('b', 'k2', base);
    m.markStatus(b.id, 'duplicate');
    expect(m.findBySha('h1')?.id).toBe(a.id);
    expect(m.findBySha('nope')).toBeUndefined();
  });

  it('shouldSkip: terminal statuses skip, failed/pending retry', () => {
    const m = mk();
    const r = m.upsert('s', 'k', base);
    expect(m.shouldSkip('s', 'k')).toBe(false);
    m.markStatus(r.id, 'failed', 'boom');
    expect(m.shouldSkip('s', 'k')).toBe(false);
    m.markStatus(r.id, 'downloaded');
    expect(m.shouldSkip('s', 'k')).toBe(true);
    expect(m.shouldSkip('s', 'unknown')).toBe(false);
  });

  it('children carry parent_id; stats counts match rows', () => {
    const m = mk();
    const p = m.upsert('s', 'zip', base);
    m.markStatus(p.id, 'extracted');
    const c = m.insertChild(p.id, 's', 'zip::a.pdf', {
      ...base,
      sha256: 'c1',
      size: 1,
      type: 'pdf',
      storageKey: 's/a.pdf',
    });
    expect(c.parentId).toBe(p.id);
    const stats = m.stats('s');
    expect(stats.extracted).toBe(1);
    expect(stats.downloaded).toBe(1);
    expect(Object.values(stats).reduce((x, y) => x + y, 0)).toBe(2);
  });

  it('listFailed returns only failed/failed_extract for the site and bumps attempts', () => {
    const m = mk();
    const a = m.upsert('s', 'a', base);
    const b = m.upsert('s', 'b', base);
    m.upsert('t', 'c', base);
    m.markStatus(a.id, 'failed', 'x');
    m.markStatus(b.id, 'downloaded');
    expect(m.listFailed('s').map((r) => r.key)).toEqual(['a']);
    expect(m.find('s', 'a')?.attempts).toBe(1);
  });
});

describe('Manifest.claimSha', () => {
  it('property: exactly one of N rows with the same hash wins the claim', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 8 }), (n) => {
        const m = mk();
        const ids = Array.from({ length: n }, (_, i) => m.upsert('s', `k${i}`, base).id);
        const results = ids.map((id) => m.claimSha(id, 'same'));
        expect(results.filter((r) => r.duplicateOf === undefined)).toHaveLength(1);
        m.close();
      }),
    );
  });
  it('a failed claimant releases its hash', () => {
    const m = mk();
    const a = m.upsert('s', 'a', base);
    const b = m.upsert('s', 'b', base);
    m.claimSha(a.id, 'h');
    m.markStatus(a.id, 'failed', 'x');
    expect(m.claimSha(b.id, 'h').duplicateOf).toBeUndefined();
  });
});
