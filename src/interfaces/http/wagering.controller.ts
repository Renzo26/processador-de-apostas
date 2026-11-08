import { Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ValidationError } from '../../application/errors';
import { ProcessWagerTransaction, type WagerTransactionResult } from '../../application/wagering/process-wager-transaction';
import { WalletQueries } from '../../application/wallet/wallet-use-cases';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import { logContext } from '../../infrastructure/observability/log-context';
import { assertProviderMatches, ProviderAuthGuard, type AuthenticatedRequest } from './auth/provider-auth.guard';
import { errorExample, TransactionDetails, WagerResult, WagerTransactionBody } from './openapi';
import { idempotencyKeySchema, wagerTransactionSchema } from './schemas';

const example = (value: Record<string, unknown>) => ({ ...WagerResult, example: value });
const txNotFound = ApiResponse({ status: 404, description: 'Transação inexistente', schema: errorExample('TRANSACTION_NOT_FOUND', 'Transaction ... not found') });

/**
 * Status por resultado (consistente com o mapeamento de erros):
 *   201 PROCESSED (primeira execução)     200 PROCESSED (replay)
 *   202 PENDING_REFERENCE                 422 REJECTED (failureCode no corpo)
 *   500 FAILED (erro permanente, auditável)
 */
function statusFor(result: WagerTransactionResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}

function body(result: WagerTransactionResult) {
  return {
    transactionId: result.transactionId,
    status: result.status,
    balance: result.balance ?? null,
    ...(result.failureCode ? { failureCode: result.failureCode } : {}),
    idempotentReplay: result.idempotentReplay,
  };
}

@ApiTags('Wagering')
@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly process: ProcessWagerTransaction,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
  ) {}

  @Post('wagering/transactions')
  @ApiOperation({
    summary: 'Submeter transação de aposta',
    description:
      'BET debita, WIN credita, LOSS só registra, REFUND devolve uma BET, ROLLBACK inverte uma BET/WIN/REFUND. ' +
      'REFUND e ROLLBACK exigem `referenceExternalTransactionId`; se a referência ainda não chegou, a resposta é 202 e a ' +
      'transação é aplicada automaticamente quando ela chegar. Repetir a mesma requisição devolve o resultado original ' +
      '(inclusive o saldo daquele momento) com `idempotentReplay: true`.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Fonte da verdade da idempotência. Recomendado: `{providerId}:{externalTransactionId}`.',
    example: 'provider-a:transaction-123',
  })
  @ApiBody({ schema: WagerTransactionBody })
  @ApiResponse({
    status: 201,
    description: 'Processada (primeira execução)',
    schema: example({ transactionId: '0192f298-345e-7e38-af88-e43f851a819d', status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false }),
  })
  @ApiResponse({
    status: 200,
    description: 'Replay: mesma Idempotency-Key e mesmo payload de uma transação já processada',
    schema: example({ transactionId: '0192f298-345e-7e38-af88-e43f851a819d', status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: true }),
  })
  @ApiResponse({
    status: 202,
    description: 'Aceita; aguardando a transação referenciada (PENDING_REFERENCE)',
    schema: example({ transactionId: '0192f298-3a1b-7c2d-9e8f-123456789abc', status: 'PENDING_REFERENCE', balance: null, idempotentReplay: false }),
  })
  @ApiResponse({
    status: 422,
    description: 'Rejeitada por regra de negócio. Decisão definitiva e auditável; não reenviar.',
    schema: example({ transactionId: '0192f298-4b2c-7d3e-8f9a-abcdef012345', status: 'REJECTED', balance: { amount: '20.00', currency: 'BRL' }, failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: false }),
  })
  @ApiResponse({
    status: 400,
    description: 'Payload inválido ou Idempotency-Key ausente',
    schema: errorExample('VALIDATION_ERROR', 'Invalid request', false, ['money.amount: Invalid input: expected string, received number']),
  })
  @ApiResponse({ status: 409, description: 'Mesma Idempotency-Key com payload diferente (não é replay)', schema: errorExample('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different payload') })
  @ApiResponse({ status: 503, description: 'Falha transitória: reenviar com a mesma Idempotency-Key', schema: errorExample('TRANSIENT_FAILURE', 'Temporary failure, retry with the same Idempotency-Key', true) })
  async submit(
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() rawBody: unknown,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKeySchema.safeParse(idempotencyKeyHeader);
    if (!key.success) {
      throw new ValidationError('Idempotency-Key header is required', key.error.issues.map((i) => `Idempotency-Key: ${i.message}`));
    }
    const idempotencyKey = key.data;
    const input = wagerTransactionSchema.parse(rawBody);
    assertProviderMatches(req, input.providerId);
    logContext.assign({ providerId: input.providerId, walletId: input.walletId });

    const result = await this.process.execute(
      { ...input, idempotencyKey },
      { correlationId: logContext.get().correlationId!, source: 'http' },
    );
    logContext.assign({ transactionId: result.transactionId });
    res.status(statusFor(result));
    return body(result);
  }

  @Get('wagering/transactions/:transactionId')
  @ApiOperation({ summary: 'Consultar transação pelo id interno' })
  @ApiParam({ name: 'transactionId', format: 'uuid' })
  @ApiResponse({ status: 200, schema: TransactionDetails })
  @txNotFound
  async get(@Param('transactionId', ParseUUIDPipe) transactionId: string, @Req() req: AuthenticatedRequest) {
    const tx = await this.queries.getTransaction(transactionId);
    assertProviderMatches(req, tx.providerId);
    return tx;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @ApiOperation({ summary: 'Consultar transação pelo id do provedor' })
  @ApiParam({ name: 'providerId', example: 'provider-a' })
  @ApiParam({ name: 'externalTransactionId', example: 'transaction-123' })
  @ApiResponse({ status: 200, schema: TransactionDetails })
  @txNotFound
  getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    assertProviderMatches(req, providerId);
    return this.queries.getTransactionByExternalId(providerId, externalTransactionId);
  }
}
