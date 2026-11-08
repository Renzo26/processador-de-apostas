import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from '../src/config';
import { newId } from '../src/domain/shared/id';
import { createSqsClient, QueueUrls } from '../src/infrastructure/messaging/sqs';

/**
 * Publica uma WagerTransactionRequested na fila (demonstração / testes manuais).
 *
 * Uso:
 *   bun scripts/send-wager-message.ts <walletId> <playerId> <kind> <amount> [externalTransactionId] [referenceExternalTransactionId]
 */
const [walletId, playerId, kind = 'BET', amount = '10.00', externalId = `tx-${newId()}`, referenceId] = process.argv.slice(2);
if (!walletId || !playerId) {
  console.error('usage: bun scripts/send-wager-message.ts <walletId> <playerId> <kind> <amount> [externalTransactionId] [referenceExternalTransactionId]');
  process.exit(1);
}

const config = loadConfig();
const sqs = createSqsClient(config);
const queueUrl = await new QueueUrls(sqs).get(config.SQS_QUEUE_NAME);
const messageId = `msg-${newId()}`;

const body = {
  messageId,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data: {
    providerId: 'provider-a',
    externalTransactionId: externalId,
    idempotencyKey: `provider-a:${externalId}`,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...(referenceId ? { referenceExternalTransactionId: referenceId } : {}),
  },
};

await sqs.send(
  new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(body),
    MessageGroupId: walletId, // unidade de concorrência = wallet
    MessageDeduplicationId: messageId,
  }),
);
console.log(JSON.stringify({ sent: messageId, externalTransactionId: externalId }));
sqs.destroy();
