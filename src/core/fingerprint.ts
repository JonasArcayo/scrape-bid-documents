export interface HeaderSet {
  'User-Agent': string;
  'Accept-Language': string;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Default header pool — adapters or callers can override this with their own pool. */
export const HEADERS_POOL: readonly HeaderSet[] = [
  {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'Accept-Language': 'es-PE,es;q=0.9,en;q=0.8',
  },
];

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Return a random header set. Pass a custom non-empty pool to override the default. */
export function getRandomHeaders(pool: readonly HeaderSet[] = HEADERS_POOL): HeaderSet {
  const source = pool.length > 0 ? pool : HEADERS_POOL;
  return source[randomInt(0, source.length - 1)]!;
}

/** Return a randomized desktop viewport size. */
export function getRandomViewport(): Viewport {
  return {
    width: randomInt(1024, 1920),
    height: randomInt(768, 1080),
  };
}

/**
 * Browser init script injected via `context.addInitScript` to spoof common
 * fingerprinting surfaces (languages, plugins, canvas, WebGL vendor/renderer).
 */
export const FINGERPRINT_INJECT_SCRIPT = `
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });

if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.toDataURL = function () {
    return 'data:image/png;base64,spoofed_canvas';
  };
}

if (typeof WebGLRenderingContext !== 'undefined') {
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (parameter) {
    if (parameter === 37445) return 'Intel Inc.';
    if (parameter === 37446) return 'Intel(R) HD Graphics';
    return getParameter.call(this, parameter);
  };
}
`.trim();
