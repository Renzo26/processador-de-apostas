import type { Clock } from '../ports/observability';
import type { UnitOfWork } from '../ports/repositories';
import type { ProcessWagerTransaction } from './process-wager-transaction';
import { newId } from '../../domain/shared/id';

/**
 * Reprocessa transações PENDING_REFERENCE vencidas. Seguro com N instâncias:
 * cada transação é reivindicada com FOR UPDATE SKIP LOCKED dentro do caso de uso,
 * e o status é revalidado sob lock (quem chega depois encontra estado terminal).
 */
export class PendingReferenceWorker {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly process: ProcessWagerTransaction,
    private readonly clock: Clock,
    private readonly batchSize = 50,
  ) {}

  async runOnce(): Promise<number> {
    const due = await this.uow.read((r) => r.transactions.findDuePendingReference(this.clock.now(), this.batchSize));
    let handled = 0;
    for (const { id, walletId } of due) {
      const result = await this.process.retryPendingReference(id, walletId, newId());
      if (result) handled++;
    }
    return handled;
  }
}
