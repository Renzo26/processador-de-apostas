import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../config';

export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    region: config.AWS_REGION,
    endpoint: config.SQS_ENDPOINT,
    credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY },
    maxAttempts: 3,
  });
}

/** Resolve (e memoriza) a URL das filas pelo nome. */
export class QueueUrls {
  private readonly cache = new Map<string, string>();

  constructor(private readonly sqs: SQSClient) {}

  async get(queueName: string): Promise<string> {
    const cached = this.cache.get(queueName);
    if (cached) return cached;
    const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
    if (!QueueUrl) throw new Error(`Queue ${queueName} not found`);
    this.cache.set(queueName, QueueUrl);
    return QueueUrl;
  }
}

export const SQS_CLIENT = Symbol('SQSClient');
