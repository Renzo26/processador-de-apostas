import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '../wallet/ledger-direction';
import { FailureCode } from './failure-code';
import { AT, brl, openWallet, wager } from './test-fixtures';
import { WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S } from './wager-transaction';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from './wager-transaction.errors';

describe('WagerTransaction', () => {
  const wallet = openWallet();

  describe('create', () => {
    it('nasce PENDING', () => {
      const tx = wager(wallet, K.Bet, '10.00');
      expect(tx.status).toBe(S.Pending);
      expect(tx.isTerminal()).toBe(false);
    });

    it('OPENING não pode ser submetido externamente', () => {
      expect(() => wager(wallet, K.Opening, '10.00')).toThrow(InvalidWagerTransactionError);
    });

    it.each([K.Refund, K.Rollback])('%s exige referenceExternalTransactionId', (kind) => {
      expect(() => wager(wallet, kind, '10.00')).toThrow(InvalidWagerTransactionError);
      expect(() => wager(wallet, kind, '10.00', { referenceExternalTransactionId: 'bet-1' })).not.toThrow();
    });

    it('não pode referenciar a si mesma', () => {
      expect(() =>
        wager(wallet, K.Refund, '10.00', { externalTransactionId: 'x', referenceExternalTransactionId: 'x' }),
      ).toThrow(InvalidWagerTransactionError);
    });

    it.each([K.Bet, K.Win, K.Refund])('%s com valor zero é inválido', (kind) => {
      expect(() => wager(wallet, kind, '0.00', { referenceExternalTransactionId: 'ref' })).toThrow(
        InvalidWagerTransactionError,
      );
    });

    it('LOSS aceita valor zero', () => {
      expect(() => wager(wallet, K.Loss, '0.00')).not.toThrow();
    });

    it.each([
      ['providerId vazio', { providerId: '' }],
      ['roundId só espaços', { roundId: '   ' }],
      ['gameId longo demais', { gameId: 'x'.repeat(129) }],
      ['payloadHash inválido', { payloadHash: 'abc' }],
    ])('rejeita %s', (_label, overrides) => {
      expect(() => wager(wallet, K.Bet, '1.00', overrides)).toThrow(InvalidWagerTransactionError);
    });
  });

  describe('transições', () => {
    it('PENDING -> PROCESSED registra saldo observado e data', () => {
      const tx = wager(wallet, K.Bet, '10.00');
      tx.markProcessed(undefined, brl('90.00'), AT);
      expect(tx.status).toBe(S.Processed);
      expect(tx.resultingBalance?.equals(brl('90.00'))).toBe(true);
      expect(tx.processedAt).toEqual(AT);
    });

    it('PENDING -> PENDING_REFERENCE -> PENDING_REFERENCE -> PROCESSED', () => {
      const tx = wager(wallet, K.Refund, '10.00', { referenceExternalTransactionId: 'bet' });
      tx.markPendingReference(AT);
      tx.markPendingReference(AT);
      expect(tx.referenceAttempts).toBe(2);
      tx.markProcessed('ref-id', brl('100.00'), AT);
      expect(tx.status).toBe(S.Processed);
      expect(tx.nextReferenceAttemptAt).toBeUndefined();
    });

    it('REJECTED carrega failureCode', () => {
      const tx = wager(wallet, K.Bet, '10.00');
      tx.reject(FailureCode.InsufficientFunds, brl('5.00'), AT);
      expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    });

    const terminalize: Record<string, (tx: WagerTransaction) => void> = {
      PROCESSED: (tx) => tx.markProcessed(undefined, brl('1.00'), AT),
      REJECTED: (tx) => tx.reject(FailureCode.InsufficientFunds, undefined, AT),
      FAILED: (tx) => tx.fail(FailureCode.ProcessingFailed, AT),
    };

    for (const [from, toTerminal] of Object.entries(terminalize)) {
      it(`${from} é terminal: qualquer nova transição lança InvalidTransactionStateError`, () => {
        const tx = wager(wallet, K.Bet, '10.00');
        toTerminal(tx);
        expect(tx.isTerminal()).toBe(true);
        expect(() => tx.markProcessed(undefined, brl('1.00'), AT)).toThrow(InvalidTransactionStateError);
        expect(() => tx.markPendingReference(AT)).toThrow(InvalidTransactionStateError);
        expect(() => tx.reject(FailureCode.InsufficientFunds, undefined, AT)).toThrow(InvalidTransactionStateError);
        expect(() => tx.fail(FailureCode.ProcessingFailed, AT)).toThrow(InvalidTransactionStateError);
      });
    }
  });

  describe('consultas', () => {
    it('affectsBalance é false apenas para LOSS', () => {
      expect(wager(wallet, K.Loss, '0.00').affectsBalance()).toBe(false);
      expect(wager(wallet, K.Bet, '1.00').affectsBalance()).toBe(true);
    });

    it('matchesPayload compara o hash canônico', () => {
      const tx = wager(wallet, K.Bet, '1.00');
      expect(tx.matchesPayload('a'.repeat(64))).toBe(true);
      expect(tx.matchesPayload('b'.repeat(64))).toBe(false);
    });

    it('ledgerDirectionFor: BET debita, WIN/REFUND creditam, ROLLBACK inverte a referência', () => {
      const bet = wager(wallet, K.Bet, '1.00');
      const win = wager(wallet, K.Win, '1.00');
      const rollback = wager(wallet, K.Rollback, '1.00', { referenceExternalTransactionId: 'r' });
      expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
      expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
      expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
      expect(() => wager(wallet, K.Loss, '0.00').ledgerDirectionFor()).toThrow();
    });
  });
});
