import pino, { type Logger } from 'pino';

export type { Logger };

/** Create the root logger. Pretty output is not bundled; pipe through pino-pretty if desired. */
export function createLogger(level = 'info'): Logger {
  return pino({ level, redact: ['password', '*.password'] });
}

/** Child logger bound with site/doc/attempt context. */
export function childLogger(
  parent: Logger,
  bindings: { site?: string; docId?: string | number; attempt?: number },
): Logger {
  return parent.child(bindings);
}
