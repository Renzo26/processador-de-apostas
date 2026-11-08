import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CreateWallet, ReconcileWallet, WalletQueries } from '../../application/wallet/wallet-use-cases';
import { logContext } from '../../infrastructure/observability/log-context';
import { assertBackoffice, ProviderAuthGuard, type AuthenticatedRequest } from './auth/provider-auth.guard';
import { CreateWalletBody, errorExample, LedgerPage, ReconciliationView, WalletView } from './openapi';
import { createWalletSchema, ledgerQuerySchema } from './schemas';

const walletIdParam = ApiParam({ name: 'walletId', format: 'uuid', example: '0192f291-27dd-7d3f-8071-5f8685deef37' });
const notFound = ApiResponse({ status: 404, description: 'Wallet inexistente', schema: errorExample('WALLET_NOT_FOUND', 'Wallet ... not found') });

@ApiTags('Wallets')
@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
    @Inject(ReconcileWallet) private readonly reconcile: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Criar wallet',
    description:
      'Saldo inicial maior que zero gera uma transação interna OPENING e um lançamento CREDIT no ledger, na mesma transação SQL. ' +
      'No máximo uma wallet por playerId + moeda.',
  })
  @ApiBody({ schema: CreateWalletBody })
  @ApiResponse({ status: 201, description: 'Wallet criada (version = 1)', schema: WalletView })
  @ApiResponse({
    status: 400,
    description: 'Payload inválido',
    schema: errorExample('VALIDATION_ERROR', 'Invalid request', false, ['initialBalance.amount: amount must be a non-negative decimal string with up to 2 decimals']),
  })
  @ApiResponse({ status: 409, description: 'Já existe wallet para o player nessa moeda', schema: errorExample('WALLET_ALREADY_EXISTS', 'Wallet for player ... in BRL already exists') })
  async create(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    assertBackoffice(req);
    const input = createWalletSchema.parse(body);
    const wallet = await this.createWallet.execute(input, logContext.get().correlationId!);
    logContext.assign({ walletId: wallet.id });
    return wallet;
  }

  @Get(':walletId')
  @ApiOperation({ summary: 'Consultar wallet' })
  @walletIdParam
  @ApiResponse({ status: 200, schema: WalletView })
  @notFound
  get(@Param('walletId', ParseUUIDPipe) walletId: string) {
    return this.queries.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  @ApiOperation({
    summary: 'Extrato (ledger) paginado',
    description: 'Lançamentos imutáveis em ordem de criação. Use o `nextCursor` (opaco e estável) para buscar a próxima página.',
  })
  @walletIdParam
  @ApiQuery({ name: 'cursor', required: false, description: 'Valor de nextCursor da página anterior' })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } })
  @ApiResponse({ status: 200, schema: LedgerPage })
  @ApiResponse({ status: 400, description: 'Cursor ou limit inválido', schema: errorExample('VALIDATION_ERROR', 'Invalid cursor') })
  @notFound
  ledger(@Param('walletId', ParseUUIDPipe) walletId: string, @Query() query: unknown) {
    const { cursor, limit } = ledgerQuerySchema.parse(query);
    return this.queries.getLedger(walletId, cursor, limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reconciliar saldo com o ledger',
    description:
      'Compara o saldo materializado com a soma dos lançamentos (calculada no banco, em NUMERIC). ' +
      'Divergências não são corrigidas: são logadas, contabilizadas em métrica e sinalizadas com consistent=false.',
  })
  @walletIdParam
  @ApiResponse({ status: 200, schema: ReconciliationView })
  @notFound
  reconciliation(@Param('walletId', ParseUUIDPipe) walletId: string, @Req() req: AuthenticatedRequest) {
    assertBackoffice(req);
    return this.reconcile.execute(walletId);
  }
}
