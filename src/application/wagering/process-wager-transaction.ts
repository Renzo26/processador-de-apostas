import { WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged } from '../../domain/events/wagering-events';
import type { EventContext } from '../../domain/events/integration-event';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money, type MoneyProps } from '../../domain/shared/money';
import { DomainError } from '../../domain/shared/domain-error';
import type { FailureCode } from '../../domain/wagering/failure-code';
import { WagerSettlement, type ReferenceLookup } from '../../domain/wagering/wager-settlement';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import { ConcurrencyConflictError, IdempotencyConflictError, ValidationError } from '../errors';
import type { Clock, Metrics } from '../ports/observability';
import type { TransactionalRepositories, UnitOfWork } from '../ports/repositories';
import { computePayloadHash } from './payload-hash';

export interface WagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

export interface CommandContext {
  correlationId: string;
  source: 'http' | 'sqs';
  /** Presente quando a entrada é SQS: deduplicação persistente por (consumerName, messageId). */
  inbox?: { consumerName: string; messageId: string } | undefined;
}

export interface WagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps | undefined;
  failureCode: FailureCode | undefined;
  idempotentReplay: boolean;
}

/**
 * Caso de uso ÚNICO para HTTP, SQS e reprocessamento de referências pendentes.
 *
 * Numa só transação SQL: inbox → lock da wallet → idempotência → regra de
 * negócio → transação + saldo + ledger + outbox. Ou tudo é confirmado, ou nada.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly settlement: WagerSettlement,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
  ) {}

  async execute(command: WagerTransactionCommand, ctx: CommandContext): Promise<WagerTransactionResult> {
    const startedAt = performance.now();
    const candidate = this.buildTransaction(command);

    const result = await runWithRaceRetry(this.metrics, 'process_wager', () => this.uow.run(async (repos) => {
      if (ctx.inbox) {
        const duplicate = await this.registerInbox(repos, ctx, candidate);
        if (duplicate) return duplicate;
      }

      // Lock da wallet ANTES de olhar idempotência/saldo/referência: duplicatas
      // concorrentes e apostas disputando o mesmo saldo serializam aqui.
      const wallet = await repos.wallets.lockById(candidate.walletId);

      const replay = await this.findReplay(repos, candidate);
      if (replay) {
        await this.completeInbox(repos, ctx);
        return replay;
      }

      const reference = await this.lookupReference(repos, candidate);
      const at = this.clock.now();
      const versionBefore = wallet?.version ?? 0;
      const outcome = this.settlement.settle({ transaction: candidate, wallet, reference, at });

      await repos.transactions.insert(candidate, ctx.correlationId);

      const eventCtx: EventContext = { correlationId: ctx.correlationId, causationId: ctx.inbox?.messageId, at };
      const events: OutboxMessage[] = [];

      if (outcome.status === WagerTransactionStatus.Processed) {
        if (outcome.entry && wallet) {
          await repos.wallets.saveBalance(wallet, versionBefore);
          await repos.ledger.append(outcome.entry, wallet.version);
          events.push(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, outcome.entry, eventCtx)));
        }
        events.push(OutboxMessage.enqueue(WagerTransactionProcessed.from(candidate, eventCtx)));
        await repos.transactions.wakeDependents(candidate.providerId, candidate.externalTransactionId, at);
      } else if (outcome.status === WagerTransactionStatus.Rejected) {
        events.push(OutboxMessage.enqueue(WagerTransactionRejected.from(candidate, eventCtx)));
      } else {
        events.push(OutboxMessage.enqueue(WagerTransactionPendingReference.from(candidate, eventCtx)));
      }

      await repos.outbox.add(events);
      await this.completeInbox(repos, ctx);
      return toResult(candidate, false);
    }));

    // Replays são contabilizados só como duplicatas: transactions_total conta decisões, não requisições.
    if (result.idempotentReplay) {
      this.metrics.duplicateDetected({ source: ctx.source, layer: 'idempotency_key' });
    } else {
      this.metrics.transactionsTotal({ kind: candidate.kind, status: result.status, source: ctx.source });
    }
    this.metrics.processingLatency((performance.now() - startedAt) / 1000, { source: ctx.source, status: result.status });
    return result;
  }

  /**
   * Reprocessa uma transação PENDING_REFERENCE (chamado pelo worker).
   * Devolve undefined se outra instância já a pegou ou se ela não está mais pendente.
   */
  async retryPendingReference(transactionId: string, walletId: string, correlationId: string): Promise<WagerTransactionResult | undefined> {
    return this.uow.run(async (repos) => {
      // Mesma ordem de lock do fluxo principal (wallet → transação): sem deadlock.
      const wallet = await repos.wallets.lockById(walletId);
      const tx = await repos.transactions.lockPendingReference(transactionId);
      if (!tx || tx.status !== WagerTransactionStatus.PendingReference) return undefined;

      const reference = await this.lookupReference(repos, tx);
      const at = this.clock.now();
      const versionBefore = wallet?.version ?? 0;
      const outcome = this.settlement.settle({ transaction: tx, wallet, reference, at });
      await repos.transactions.update(tx);

      const eventCtx: EventContext = { correlationId, causationId: tx.id, at };
      const events: OutboxMessage[] = [];
      if (outcome.status === WagerTransactionStatus.Processed) {
        if (outcome.entry && wallet) {
          await repos.wallets.saveBalance(wallet, versionBefore);
          await repos.ledger.append(outcome.entry, wallet.version);
          events.push(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, outcome.entry, eventCtx)));
        }
        events.push(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, eventCtx)));
        await repos.transactions.wakeDependents(tx.providerId, tx.externalTransactionId, at);
      } else if (outcome.status === WagerTransactionStatus.Rejected) {
        events.push(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, eventCtx)));
      } else {
        events.push(OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, eventCtx)));
      }
      await repos.outbox.add(events);
      this.metrics.retry({ operation: 'pending_reference', reason: outcome.status });
      return toResult(tx, false);
    });
  }

  private buildTransaction(command: WagerTransactionCommand): WagerTransaction {
    try {
      if (command.kind === WagerTransactionKind.Opening) {
        throw new ValidationError('OPENING is internal and cannot be submitted');
      }
      const money = Money.from(command.money);
      return WagerTransaction.create({
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash: computePayloadHash({ ...command, money: money.toJSON() }),
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind as WagerTransactionKind,
        money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        createdAt: this.clock.now(),
      });
    } catch (error) {
      if (error instanceof DomainError) throw new ValidationError(error.message, [error.code]);
      throw error;
    }
  }

  /** Devolve o resultado original quando a mensagem SQS já foi processada (redelivery). */
  private async registerInbox(
    repos: TransactionalRepositories,
    ctx: CommandContext,
    candidate: WagerTransaction,
  ): Promise<WagerTransactionResult | undefined> {
    const inbox = InboxMessage.receive({
      messageId: ctx.inbox!.messageId,
      consumerName: ctx.inbox!.consumerName,
      payloadHash: candidate.payloadHash,
      receivedAt: this.clock.now(),
    });
    const registration = await repos.inbox.register(inbox);
    if (registration.inserted) return undefined;

    this.metrics.duplicateDetected({ source: ctx.source, layer: 'inbox' });
    if (registration.existing.payloadHash !== candidate.payloadHash) {
      throw new IdempotencyConflictError('INBOX_MESSAGE_ID_REUSED');
    }
    const original = await repos.transactions.findByIdempotencyKey(candidate.providerId, candidate.idempotencyKey);
    // Inbox gravada implica transação gravada (mesmo commit). A ausência indicaria corrupção.
    if (!original) throw new Error(`Inbox ${inbox.messageId} registered without its transaction`);
    return toResult(original, true);
  }

  private async completeInbox(repos: TransactionalRepositories, ctx: CommandContext): Promise<void> {
    if (!ctx.inbox) return;
    const inbox = InboxMessage.rehydrate({
      messageId: ctx.inbox.messageId,
      consumerName: ctx.inbox.consumerName,
      payloadHash: '',
      receivedAt: this.clock.now(),
    });
    inbox.markProcessed(this.clock.now());
    await repos.inbox.markProcessed(inbox);
  }

  private async findReplay(repos: TransactionalRepositories, candidate: WagerTransaction): Promise<WagerTransactionResult | undefined> {
    const byKey = await repos.transactions.findByIdempotencyKey(candidate.providerId, candidate.idempotencyKey);
    if (byKey) {
      if (!byKey.matchesPayload(candidate.payloadHash)) throw new IdempotencyConflictError('IDEMPOTENCY_KEY_REUSED');
      return toResult(byKey, true);
    }
    const byExternalId = await repos.transactions.findByExternalId(candidate.providerId, candidate.externalTransactionId);
    if (byExternalId) throw new IdempotencyConflictError('EXTERNAL_TRANSACTION_ID_REUSED');
    return undefined;
  }

  private async lookupReference(repos: TransactionalRepositories, tx: WagerTransaction): Promise<ReferenceLookup | undefined> {
    if (!tx.referenceExternalTransactionId) return undefined;
    const reference = await repos.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId);
    if (!reference) return { found: false };
    return { found: true, transaction: reference, alreadyReversed: await repos.transactions.isReversed(reference.id) };
  }
}

const MAX_RACE_RETRIES = 3;

/**
 * Reexecuta a unidade de trabalho quando o banco acusa uma corrida perdida
 * (unique violation em chave de idempotência, versão de wallet já usada).
 * Na nova tentativa o vencedor já está commitado e o fluxo cai no replay.
 * O efeito financeiro nunca duplica: a constraint é quem decide o vencedor.
 */
export async function runWithRaceRetry<T>(metrics: Metrics, operation: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof ConcurrencyConflictError) || attempt >= MAX_RACE_RETRIES) throw error;
      metrics.lockConflict({ operation });
      metrics.retry({ operation, reason: error.constraint });
    }
  }
}

export function toResult(tx: WagerTransaction, idempotentReplay: boolean): WagerTransactionResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.resultingBalance?.toJSON(),
    failureCode: tx.failureCode,
    idempotentReplay,
  };
}
