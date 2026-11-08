import { appLogger } from '../../infrastructure/observability/json-logger';

/**
 * Laço de polling com parada graciosa: `stop()` impede novos ciclos e aguarda
 * o ciclo em andamento terminar (nunca interrompe uma transação no meio).
 * Quando um ciclo encontra trabalho, o próximo roda imediatamente (drena backlog).
 */
export class PollingLoop {
  private running = false;
  private current: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<number>,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.current = this.loop();
    appLogger.info('worker.started', { worker: this.name });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.current;
    appLogger.info('worker.stopped', { worker: this.name });
  }

  private async loop(): Promise<void> {
    let failures = 0;
    while (this.running) {
      let didWork = false;
      try {
        didWork = (await this.tick()) > 0;
        failures = 0;
      } catch (error) {
        failures++;
        appLogger.warn('worker.tick.failed', { worker: this.name, failures, error: error instanceof Error ? error.message : String(error) });
      }
      if (!this.running) break;
      if (!didWork) {
        // backoff em falhas consecutivas (ex.: banco fora do ar), limitado a 30s
        const delay = failures > 0 ? Math.min(this.intervalMs * 2 ** failures, 30_000) : this.intervalMs;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    }
  }
}
