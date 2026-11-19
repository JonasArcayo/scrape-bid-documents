import type { Logger } from '../core/logger.js';

export interface Shutdown {
  /** Aborted on the first SIGINT/SIGTERM. Stop discovery; let in-flight work finish. */
  signal: AbortSignal;
  /** Remove signal handlers (call when the run ends). */
  dispose(): void;
}

/** Install graceful SIGINT/SIGTERM handling: first signal aborts, second forces exit. */
export function installShutdown(logger: Logger, proc: NodeJS.Process = process): Shutdown {
  const controller = new AbortController();
  const handler = (sig: string) => {
    if (controller.signal.aborted) {
      logger.warn({ sig }, 'second signal received, forcing exit');
      proc.exit(130);
      return;
    }
    logger.warn({ sig }, 'shutdown requested: stopping discovery, finishing in-flight downloads');
    controller.abort();
  };
  const onInt = () => handler('SIGINT');
  const onTerm = () => handler('SIGTERM');
  proc.on('SIGINT', onInt);
  proc.on('SIGTERM', onTerm);
  return {
    signal: controller.signal,
    dispose: () => {
      proc.off('SIGINT', onInt);
      proc.off('SIGTERM', onTerm);
    },
  };
}
