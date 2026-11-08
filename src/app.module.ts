import { Inject, Module, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { CLOCK, METRICS, systemClock, type Clock, type Metrics } from './application/ports/observability';
import { UNIT_OF_WORK, type UnitOfWork } from './application/ports/repositories';
import { ProcessWagerTransaction } from './application/wagering/process-wager-transaction';
import { CreateWallet, ReconcileWallet, WalletQueries } from './application/wallet/wallet-use-cases';
import { APP_CONFIG, loadConfig, type AppConfig } from './config';
import { ReferenceRetryPolicy } from './domain/wagering/reference-retry-policy';
import { WagerSettlement } from './domain/wagering/wager-settlement';
import { buildOrmConfig } from './infrastructure/database/mikro-orm.config';
import { PgUnitOfWork } from './infrastructure/database/postgres-unit-of-work';
import { createSqsClient, QueueUrls, SQS_CLIENT } from './infrastructure/messaging/sqs';
import { appLogger } from './infrastructure/observability/json-logger';
import { PrometheusMetrics } from './infrastructure/observability/prometheus-metrics';
import { OutboxRelay } from './application/messaging/outbox-relay';
import { EVENT_PUBLISHER, OUTBOX_STORE, type EventPublisher, type OutboxStore } from './application/ports/messaging';
import { PendingReferenceWorker } from './application/wagering/pending-reference-worker';
import { PgOutboxStore } from './infrastructure/database/pg-outbox-store';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher';
import { WagerTransactionsConsumer } from './interfaces/sqs/wager-transactions.consumer';
import { BackgroundWorkers } from './interfaces/workers/background-workers';
import { PROVIDER_IDENTITY, ProviderAuthGuard } from './interfaces/http/auth/provider-auth.guard';
import { HealthController } from './interfaces/http/health.controller';
import { WageringController } from './interfaces/http/wagering.controller';
import { WalletsController } from './interfaces/http/wallets.controller';

/**
 * Composição explícita via factories: o domínio e a aplicação não têm
 * decorators do Nest — só esta camada conhece o framework.
 */
const providers: Provider[] = [
  { provide: APP_CONFIG, useFactory: () => loadConfig() },
  { provide: CLOCK, useValue: systemClock },
  { provide: PrometheusMetrics, useFactory: () => new PrometheusMetrics() },
  { provide: METRICS, useExisting: PrometheusMetrics },
  {
    provide: MikroORM,
    inject: [APP_CONFIG],
    useFactory: async (config: AppConfig) => {
      const orm = await MikroORM.init(buildOrmConfig({ clientUrl: config.DATABASE_URL, pool: { min: 2, max: config.DB_POOL_MAX } }));
      if (config.RUN_MIGRATIONS) await orm.migrator.up();
      return orm;
    },
  },
  {
    provide: UNIT_OF_WORK,
    inject: [MikroORM, APP_CONFIG],
    useFactory: (orm: MikroORM, config: AppConfig) =>
      new PgUnitOfWork(orm, { lockTimeoutMs: config.DB_LOCK_TIMEOUT_MS, statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS }),
  },
  {
    provide: WagerSettlement,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig) =>
      new WagerSettlement(
        ReferenceRetryPolicy.create({
          maxAttempts: config.REFERENCE_MAX_ATTEMPTS,
          baseDelayMs: config.REFERENCE_BASE_DELAY_MS,
          maxDelayMs: config.REFERENCE_MAX_DELAY_MS,
        }),
      ),
  },
  {
    provide: ProcessWagerTransaction,
    inject: [UNIT_OF_WORK, WagerSettlement, CLOCK, METRICS],
    useFactory: (uow: UnitOfWork, settlement: WagerSettlement, clock: Clock, metrics: Metrics) =>
      new ProcessWagerTransaction(uow, settlement, clock, metrics),
  },
  { provide: CreateWallet, inject: [UNIT_OF_WORK, CLOCK], useFactory: (uow: UnitOfWork, clock: Clock) => new CreateWallet(uow, clock) },
  { provide: WalletQueries, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new WalletQueries(uow) },
  {
    provide: ReconcileWallet,
    inject: [UNIT_OF_WORK, METRICS],
    useFactory: (uow: UnitOfWork, metrics: Metrics) =>
      new ReconcileWallet(uow, metrics, (view) =>
        appLogger.warn('wallet.reconciliation.mismatch', {
          walletId: view.walletId,
          storedAmount: view.storedBalance.amount,
          calculatedAmount: view.calculatedBalance.amount,
          checkedEntries: view.checkedEntries,
        }),
      ),
  },
  { provide: SQS_CLIENT, inject: [APP_CONFIG], useFactory: (config: AppConfig) => createSqsClient(config) },
  { provide: QueueUrls, inject: [SQS_CLIENT], useFactory: (sqs: SQSClient) => new QueueUrls(sqs) },
  { provide: OUTBOX_STORE, inject: [MikroORM], useFactory: (orm: MikroORM) => new PgOutboxStore(orm) },
  {
    provide: EVENT_PUBLISHER,
    inject: [SQS_CLIENT, QueueUrls, APP_CONFIG],
    useFactory: (sqs: SQSClient, queues: QueueUrls, config: AppConfig) => new SqsEventPublisher(sqs, queues, config.SQS_EVENTS_QUEUE_NAME),
  },
  {
    provide: OutboxRelay,
    inject: [OUTBOX_STORE, EVENT_PUBLISHER, CLOCK, METRICS, APP_CONFIG],
    useFactory: (store: OutboxStore, publisher: EventPublisher, clock: Clock, metrics: Metrics, config: AppConfig) =>
      new OutboxRelay(store, publisher, clock, metrics, {
        owner: config.INSTANCE_ID,
        batchSize: config.OUTBOX_BATCH_SIZE,
        leaseMs: config.OUTBOX_LEASE_MS,
      }),
  },
  {
    provide: PendingReferenceWorker,
    inject: [UNIT_OF_WORK, ProcessWagerTransaction, CLOCK],
    useFactory: (uow: UnitOfWork, process: ProcessWagerTransaction, clock: Clock) => new PendingReferenceWorker(uow, process, clock),
  },
  {
    provide: WagerTransactionsConsumer,
    inject: [SQS_CLIENT, QueueUrls, ProcessWagerTransaction, METRICS, APP_CONFIG],
    useFactory: (sqs: SQSClient, queues: QueueUrls, process: ProcessWagerTransaction, metrics: Metrics, config: AppConfig) =>
      new WagerTransactionsConsumer(sqs, queues, process, metrics, {
        queueName: config.SQS_QUEUE_NAME,
        dlqName: config.SQS_DLQ_NAME,
        maxReceiveCount: config.SQS_MAX_RECEIVE_COUNT,
        concurrency: config.SQS_CONSUMER_CONCURRENCY,
        waitTimeSeconds: 10,
        maxBackoffSeconds: 60,
        faultInjection: config.FAULT_INJECTION,
      }),
  },
  {
    provide: BackgroundWorkers,
    inject: [APP_CONFIG, WagerTransactionsConsumer, OutboxRelay, PendingReferenceWorker, OUTBOX_STORE, PrometheusMetrics, SQS_CLIENT, QueueUrls],
    useFactory: (
      config: AppConfig,
      consumer: WagerTransactionsConsumer,
      relay: OutboxRelay,
      pending: PendingReferenceWorker,
      store: OutboxStore,
      metrics: PrometheusMetrics,
      sqs: SQSClient,
      queues: QueueUrls,
    ) => new BackgroundWorkers(config, consumer, relay, pending, store, metrics, sqs, queues),
  },
  // Ponto de extensão de autenticação: undefined = guard no-op (ver ARCHITECTURE.md).
  { provide: PROVIDER_IDENTITY, useValue: undefined },
  ProviderAuthGuard,
];

@Module({
  controllers: [HealthController, WalletsController, WageringController],
  providers,
  exports: providers,
})
export class AppModule implements OnApplicationShutdown {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  /** Último passo do shutdown: workers e consumer já pararam (hooks anteriores). */
  async onApplicationShutdown(): Promise<void> {
    this.sqs.destroy();
    await this.orm.close();
  }
}
