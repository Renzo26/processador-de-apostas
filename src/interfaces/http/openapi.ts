import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type ApiResponseSchemaHost } from '@nestjs/swagger';
import { z } from 'zod';
import { FailureCode } from '../../domain/wagering/failure-code';
import { createWalletSchema, moneySchema, wagerTransactionSchema } from './schemas';

/** SchemaObject do OpenAPI (o pacote não o exporta pela raiz). */
type SchemaObject = ApiResponseSchemaHost['schema'] & { properties?: Record<string, unknown> };

/**
 * Schemas de ENTRADA gerados a partir dos mesmos schemas zod usados na
 * validação: a documentação não tem como divergir do que a API aceita.
 */
function fromZod(schema: z.ZodType): SchemaObject {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return json as SchemaObject;
}

const money: SchemaObject = {
  ...fromZod(moneySchema),
  example: { amount: '25.00', currency: 'BRL' },
};

export const CreateWalletBody: SchemaObject = {
  ...fromZod(createWalletSchema),
  example: { playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1', initialBalance: { amount: '1000.00', currency: 'BRL' } },
};

export const WagerTransactionBody: SchemaObject = {
  ...fromZod(wagerTransactionSchema),
  example: {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
};

// ---------------------------------------------------------------- respostas

export const WalletView: SchemaObject = {
  type: 'object',
  required: ['id', 'playerId', 'balance', 'version'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    playerId: { type: 'string', format: 'uuid' },
    balance: money,
    version: { type: 'integer', minimum: 1, description: 'Começa em 1 e só incrementa quando o saldo muda' },
  },
  example: {
    id: '0192f291-27dd-7d3f-8071-5f8685deef37',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    balance: { amount: '1000.00', currency: 'BRL' },
    version: 1,
  },
};

const statusEnum = ['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'];

export const WagerResult: SchemaObject = {
  type: 'object',
  required: ['transactionId', 'status', 'balance', 'idempotentReplay'],
  properties: {
    transactionId: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: statusEnum },
    balance: { ...money, nullable: true, description: 'Saldo observado no momento da decisão (replay devolve o mesmo valor)' },
    failureCode: { type: 'string', enum: Object.values(FailureCode), description: 'Presente quando REJECTED/FAILED' },
    idempotentReplay: { type: 'boolean', description: 'true quando a resposta é a repetição de uma requisição já processada' },
  },
};

export const TransactionDetails: SchemaObject = {
  type: 'object',
  properties: {
    ...WagerResult.properties,
    kind: { type: 'string', enum: ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] },
    providerId: { type: 'string' },
    externalTransactionId: { type: 'string' },
  },
};

export const LedgerPage: SchemaObject = {
  type: 'object',
  required: ['items', 'nextCursor'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          transactionId: { type: 'string', format: 'uuid' },
          direction: { type: 'string', enum: ['DEBIT', 'CREDIT'] },
          money,
          balanceBefore: money,
          balanceAfter: money,
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
    nextCursor: { type: 'string', nullable: true, description: 'Cursor opaco para a próxima página; null quando acabou' },
  },
};

export const ReconciliationView: SchemaObject = {
  type: 'object',
  properties: {
    walletId: { type: 'string', format: 'uuid' },
    storedBalance: money,
    calculatedBalance: money,
    difference: money,
    consistent: { type: 'boolean' },
    checkedEntries: { type: 'integer' },
  },
  example: {
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    storedBalance: { amount: '975.00', currency: 'BRL' },
    calculatedBalance: { amount: '975.00', currency: 'BRL' },
    difference: { amount: '0.00', currency: 'BRL' },
    consistent: true,
    checkedEntries: 42,
  },
};

export const ErrorBody: SchemaObject = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'retryable'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        retryable: { type: 'boolean', description: 'Pode reenviar a MESMA requisição (mesma Idempotency-Key)?' },
        details: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

/** Resposta de erro com exemplo. */
export const errorExample = (code: string, message: string, retryable = false, details?: string[]): SchemaObject => ({
  ...ErrorBody,
  example: { error: { code, message, retryable, ...(details ? { details } : {}) } },
});

const API_DESCRIPTION = `
Processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) com idempotência persistente,
concorrência segura entre múltiplas instâncias e ledger imutável.

**Como testar aqui:** crie uma wallet em \`POST /wallets\`, copie \`id\` e \`playerId\` da resposta
e use-os em \`POST /wagering/transactions\`. Repita a mesma requisição para ver o replay idempotente.

**Status HTTP (consistentes em todos os endpoints):**

| Status | Significado | Reenviar? |
|---|---|---|
| 201 / 200 | processada / replay idempotente | — |
| 202 | aceita, aguardando a transação referenciada | consultar depois |
| 422 | rejeitada por regra de negócio (\`failureCode\`) | não |
| 400 | payload inválido | só depois de corrigir |
| 409 | conflito de idempotência / wallet duplicada | não |
| 503 | falha transitória | sim, com a mesma Idempotency-Key |

Decisões de arquitetura: ver \`ARCHITECTURE.md\` no repositório.
`;

/** Swagger UI em /docs e o documento OpenAPI em /docs-json. */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Processador Distribuído de Apostas')
    .setDescription(API_DESCRIPTION)
    .setVersion('1.0.0')
    .addTag('Wallets', 'Criação, consulta, extrato e reconciliação')
    .addTag('Wagering', 'Submissão e consulta de transações de apostas')
    .addTag('Operação', 'Health checks e métricas (sem autenticação)')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs-json',
    customSiteTitle: 'Processador de Apostas — API',
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true, tryItOutEnabled: true },
  });
}
