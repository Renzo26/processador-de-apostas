import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../application/ports/messaging';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { QueueUrls } from './sqs';

const SQS_BATCH_LIMIT = 10;

/**
 * Publica na fila FIFO de eventos:
 *  - MessageGroupId = aggregateId → ordem preservada por wallet/transação;
 *  - MessageDeduplicationId = eventId → republicações dentro da janela de 5 min
 *    são descartadas pelo próprio SQS (otimização; o consumidor ainda deduplica
 *    por eventId, que é a garantia de fato).
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: QueueUrls,
    private readonly queueName: string,
  ) {}

  async publish(messages: OutboxMessage[]) {
    const results = new Map<string, { ok: true } | { ok: false; error: string }>();
    let queueUrl: string;
    try {
      queueUrl = await this.queues.get(this.queueName);
    } catch (error) {
      for (const m of messages) results.set(m.id, { ok: false, error: describe(error) });
      return results;
    }

    for (let i = 0; i < messages.length; i += SQS_BATCH_LIMIT) {
      const chunk = messages.slice(i, i + SQS_BATCH_LIMIT);
      try {
        const out = await this.sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: chunk.map((m, idx) => ({
              Id: String(idx),
              MessageBody: JSON.stringify(m.payload),
              MessageGroupId: m.aggregateId,
              MessageDeduplicationId: m.id,
              MessageAttributes: { eventType: { DataType: 'String', StringValue: m.eventType } },
            })),
          }),
        );
        for (const ok of out.Successful ?? []) results.set(chunk[Number(ok.Id)]!.id, { ok: true });
        for (const failed of out.Failed ?? []) {
          results.set(chunk[Number(failed.Id)]!.id, { ok: false, error: `${failed.Code}: ${failed.Message ?? ''}` });
        }
      } catch (error) {
        for (const m of chunk) results.set(m.id, { ok: false, error: describe(error) });
      }
    }
    return results;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
