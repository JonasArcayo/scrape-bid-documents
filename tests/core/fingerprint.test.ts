import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import {
  FINGERPRINT_INJECT_SCRIPT,
  HEADERS_POOL,
  getRandomHeaders,
  getRandomViewport,
  type HeaderSet,
} from '../../src/core/fingerprint.js';

describe('fingerprint', () => {
  it('getRandomHeaders returns a header set from the default pool', () => {
    for (let i = 0; i < 10; i++) {
      const headers = getRandomHeaders();
      expect(HEADERS_POOL).toContainEqual(headers);
    }
  });

  it('getRandomHeaders uses a custom pool when provided and falls back when empty', () => {
    const custom: HeaderSet[] = [{ 'User-Agent': 'CustomUA/1.0', 'Accept-Language': 'fr-FR' }];
    expect(getRandomHeaders(custom)).toEqual(custom[0]);
    expect(HEADERS_POOL).toContainEqual(getRandomHeaders([]));
  });

  it('getRandomViewport returns dimensions within expected desktop bounds', () => {
    for (let i = 0; i < 20; i++) {
      const vp = getRandomViewport();
      expect(vp.width).toBeGreaterThanOrEqual(1024);
      expect(vp.width).toBeLessThanOrEqual(1920);
      expect(vp.height).toBeGreaterThanOrEqual(768);
      expect(vp.height).toBeLessThanOrEqual(1080);
    }
  });

  it('FINGERPRINT_INJECT_SCRIPT is syntactically valid JS with expected hooks', () => {
    expect(() => new Function(FINGERPRINT_INJECT_SCRIPT)).not.toThrow();
    expect(FINGERPRINT_INJECT_SCRIPT).toContain("navigator, 'languages'");
    expect(FINGERPRINT_INJECT_SCRIPT).toContain("navigator, 'plugins'");
    expect(FINGERPRINT_INJECT_SCRIPT).toContain('HTMLCanvasElement.prototype.toDataURL');
    expect(FINGERPRINT_INJECT_SCRIPT).toContain('WebGLRenderingContext.prototype.getParameter');
  });

  it('loadConfig parses FINGERPRINT from env and defaults to true', () => {
    expect(loadConfig({}).site.fingerprint).toBe(true);
    expect(loadConfig({ FINGERPRINT: 'false' }).site.fingerprint).toBe(false);
  });
});
