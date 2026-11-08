import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { loadConfig } from '../../src/config';
import { newId } from '../../src/domain/shared/id';
import { createSqsClient, QueueUrls } from '../../src/infrastructure/messaging/sqs';
import type { WagerTransactionCommand } from '../../src/application/wagering/process-wager-transaction';

export const sqsClient = (): SQSClient => createSqsClient(loadConfig());

/** Filas FIFO exclusivas do teste (principal + DLQ com redrive), apagadas no final. */
export async function createTestQueues(sqs: SQSClient, opts: { maxReceiveCount?: number; visibilityTimeout?: number } = {}) {
  const suffix = newId().slice(-12);
  const dlqName = `t-${suffix}-dlq.fifo`;
  const queueName = `t-${suffix}.fifo`;
  const eventsName = `t-${suffix}-events.fifo`;

  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: dlqName, Attributes: { FifoQueue: 'true' } }));
  const dlqArn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }))).Attributes!.QueueArn!;
  const main = await sqs.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: String(opts.visibilityTimeout ?? 2),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: String(opts.maxReceiveCount ?? 3) }),
      },
    }),
  );
  const events = await sqs.send(new CreateQueueCommand({ QueueName: eventsName, Attributes: { FifoQueue: 'true' } }));

  return {
    queueName,
    dlqName,
    eventsName,
    queueUrl: main.QueueUrl!,
    dlqUrl: dlq.QueueUrl!,
    eventsUrl: events.QueueUrl!,
    queues: new QueueUrls(sqs),
    async cleanup() {
      for (const url of [main.QueueUrl, dlq.QueueUrl, events.QueueUrl]) {
        await sqs.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => {});
      }
    },
  };
}

export async function sendWagerMessage(
  sqs: SQSClient,
  queueUrl: string,
  command: WagerTransactionCommand,
  opts: { messageId?: string; dedupId?: string } = {},
): Promise<string> {
  const messageId = opts.messageId ?? `msg-${newId()}`;
  const { idempotencyKey, ...data } = command;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: { ...data, idempotencyKey },
      }),
      MessageGroupId: command.walletId,
      // dedupId diferente do messageId simula redelivery que escapa da deduplicação do SQS
      MessageDeduplicationId: opts.dedupId ?? newId(),
    }),
  );
  return messageId;
}

export async function queueDepth(sqs: SQSClient, queueUrl: string): Promise<number> {
  const out = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }),
  );
  return Number(out.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(out.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
}

export async function drain(sqs: SQSClient, queueUrl: string, waitSeconds = 1) {
  const out = await sqs.send(
    new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: waitSeconds, MessageAttributeNames: ['All'] }),
  );
  return out.Messages ?? [];
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 15_000, intervalMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
