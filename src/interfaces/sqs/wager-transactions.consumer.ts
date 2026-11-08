import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { IdempotencyConflictError, TransientInfrastructureError, ValidationError } from '../../application/errors';
import type { Metrics } from '../../application/ports/observability';
import type { ProcessWagerTransaction } from '../../application/wagering/process-wager-transaction';
import { newId } from '../../domain/shared/id';
import type { QueueUrls } from '../../infrastructure/messaging/sqs';
import { appLogger } from '../../infrastructure/observability/json-logger';
import { logContext } from '../../infrastructure/observability/log-context';
import { wagerMessageSchema, type WagerMessage } from './wager-message';

export const CONSUMER_NAME = 'wager-transactions-consumer';

export interface ConsumerOptions {
  queueName: string;
  dlqName: string;
  maxReceiveCount: number;
  concurrency: number;
  waitTimeSeconds: number;
  /** Teto do backoff de visibilidade para erros transitórios. */
  maxBackoffSeconds: number;
  /**
   * Fault injection para testes de resiliência (desligado em produção):
   * 'crash-before-ack' encerra o processo com SIGKILL logo após o commit e antes do ack.
   */
  faultInjection?: 'crash-before-ack' | undefined;
}

/** Como a mensagem terminou — usado em logs, métricas e testes. */
export type MessageDisposition = 'acked' | 'acked_business_conflict' | 'retry_scheduled' | 'dead_lettered' | 'released';

/**
 * Consumidor da fila wager-transactions.fifo.
 *
 *  - reutiliza o MESMO caso de uso do HTTP;
 *  - deduplica via inbox persistente (consumerName, messageId), dentro da transação;
 *  - ack (DeleteMessage) SOMENTE após o commit;
 *  - classifica erros:
 *      negócio (rejeição, conflito de idempotência) → terminal, ack;
 *      transitório (banco/lock)                      → backoff via visibilidade, até maxReceiveCount;
 *      permanente (payload inválido, tentativas esgotadas) → DLQ explícita + ack;
 *  - em SIGTERM: para de receber, conclui o que está em andamento e devolve a
 *    visibilidade (timeout 0) do que ainda não começou.
 */
export class WagerTransactionsConsumer {
  private running = false;
  private loopPromise: Promise<void> | undefined;
  private abort: AbortController | undefined;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: QueueUrls,
    private readonly process: ProcessWagerTransaction,
    private readonly metrics: Metrics,
    private readonly options: ConsumerOptions,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
    appLogger.info('sqs.consumer.started', { queue: this.options.queueName });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort?.abort();
    await this.loopPromise;
    await Promise.allSettled([...this.inFlight]);
    appLogger.info('sqs.consumer.stopped', { queue: this.options.queueName });
  }

  /** Um ciclo de recebimento (exposto para testes determinísticos). */
  async pollOnce(waitTimeSeconds = this.options.waitTimeSeconds): Promise<MessageDisposition[]> {
    const queueUrl = await this.queues.get(this.options.queueName);
    this.abort = new AbortController();
    let messages: Message[] = [];
    try {
      const out = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: Math.min(10, this.options.concurrency),
          WaitTimeSeconds: waitTimeSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        }),
        { abortSignal: this.abort.signal },
      );
      messages = out.Messages ?? [];
    } catch (error) {
      if (!this.running && this.abort.signal.aborted) return [];
      throw error;
    }

    // FIFO: mensagens do mesmo grupo em ordem; grupos diferentes em paralelo.
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const group = m.Attributes?.MessageGroupId ?? m.MessageId ?? newId();
      groups.set(group, [...(groups.get(group) ?? []), m]);
    }

    const dispositions: MessageDisposition[] = [];
    const work = [...groups.values()].map(async (batch) => {
      for (const message of batch) {
        if (!this.running && this.loopPromise) {
          // shutdown: o que não começou volta para a fila imediatamente
          await this.release(queueUrl, message);
          dispositions.push('released');
          continue;
        }
        dispositions.push(await this.handle(queueUrl, message));
      }
    });
    const all = Promise.all(work);
    this.inFlight.add(all);
    try {
      await all;
    } finally {
      this.inFlight.delete(all);
    }
    return dispositions;
  }

  private async loop(): Promise<void> {
    let failures = 0;
    while (this.running) {
      try {
        await this.pollOnce();
        failures = 0;
      } catch (error) {
        failures++;
        appLogger.warn('sqs.consumer.poll.failed', { failures, error: error instanceof Error ? error.message : String(error) });
        await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** failures, 30_000)));
      }
    }
  }

  async handle(queueUrl: string, message: Message): Promise<MessageDisposition> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');

    let parsed: WagerMessage;
    try {
      parsed = wagerMessageSchema.parse(JSON.parse(message.Body ?? ''));
    } catch (error) {
      // Permanente: nenhuma reentrega vai tornar o payload válido.
      return this.deadLetter(queueUrl, message, 'INVALID_MESSAGE', error);
    }

    const correlationId = parsed.correlationId ?? parsed.messageId;
    return logContext.run(
      { correlationId, messageId: parsed.messageId, providerId: parsed.data.providerId, walletId: parsed.data.walletId },
      async () => {
        try {
          const { idempotencyKey, ...data } = parsed.data;
          const result = await this.process.execute(
            { ...data, idempotencyKey },
            { correlationId, source: 'sqs', inbox: { consumerName: CONSUMER_NAME, messageId: parsed.messageId } },
          );
          logContext.assign({ transactionId: result.transactionId });
          if (this.options.faultInjection === 'crash-before-ack' && !result.idempotentReplay) {
            appLogger.warn('fault_injection.crash_before_ack', {});
            process.kill(process.pid, 'SIGKILL');
          }
          // Commit concluído → só agora o ack.
          await this.ack(queueUrl, message);
          appLogger.info('sqs.message.processed', { status: result.status, failureCode: result.failureCode, replay: result.idempotentReplay });
          return 'acked';
        } catch (error) {
          if (error instanceof IdempotencyConflictError) {
            // Negócio/terminal: reentregar não muda o resultado.
            await this.ack(queueUrl, message);
            appLogger.warn('sqs.message.idempotency_conflict', { code: error.code });
            return 'acked_business_conflict';
          }
          if (error instanceof ValidationError) {
            return this.deadLetter(queueUrl, message, 'INVALID_PAYLOAD', error);
          }
          // Transitório (ou inesperado): retry com backoff até o limite; depois DLQ.
          if (receiveCount >= this.options.maxReceiveCount) {
            return this.deadLetter(queueUrl, message, 'MAX_ATTEMPTS_EXCEEDED', error);
          }
          const backoff = Math.min(2 ** receiveCount, this.options.maxBackoffSeconds);
          this.metrics.retry({ operation: 'sqs_message', reason: error instanceof TransientInfrastructureError ? 'transient' : 'unexpected' });
          appLogger.warn('sqs.message.retry_scheduled', {
            receiveCount,
            backoffSeconds: backoff,
            error: error instanceof Error ? error.message : String(error),
          });
          await this.changeVisibility(queueUrl, message, backoff);
          return 'retry_scheduled';
        }
      },
    );
  }

  private async ack(queueUrl: string, message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private async release(queueUrl: string, message: Message): Promise<void> {
    await this.changeVisibility(queueUrl, message, 0);
  }

  private async changeVisibility(queueUrl: string, message: Message, seconds: number): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: seconds }),
      );
    } catch (error) {
      // Se falhar, a visibilidade original expira sozinha: a mensagem volta de qualquer forma.
      appLogger.warn('sqs.message.visibility_change_failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * DLQ explícita para erros permanentes: preserva o corpo original e o motivo.
   * Só remove da fila principal depois que a DLQ aceitou (senão a redrive policy
   * do SQS ainda leva a mensagem para a DLQ após maxReceiveCount).
   */
  private async deadLetter(queueUrl: string, message: Message, reason: string, error: unknown): Promise<MessageDisposition> {
    const dlqUrl = await this.queues.get(this.options.dlqName);
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId ?? newId(),
        MessageAttributes: {
          deadLetterReason: { DataType: 'String', StringValue: reason },
          error: { DataType: 'String', StringValue: (error instanceof Error ? error.message : String(error)).slice(0, 256) || 'n/a' },
        },
      }),
    );
    await this.ack(queueUrl, message);
    this.metrics.messageToDlq({ reason });
    appLogger.error('sqs.message.dead_lettered', { reason, sqsMessageId: message.MessageId });
    return 'dead_lettered';
  }
}
