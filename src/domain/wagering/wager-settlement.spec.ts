import { beforeEach, describe, expect, it } from 'bun:test';
import { newId } from '../shared/id';
import { Money } from '../shared/money';
import { LedgerDirection } from '../wallet/ledger-direction';
import type { Wallet } from '../wallet/wallet';
import { FailureCode } from './failure-code';
import { ReferenceRetryPolicy } from './reference-retry-policy';
import { AT, brl, openWallet, wager } from './test-fixtures';
import { WagerTransactionKind as K, WagerTransactionStatus as S, type WagerTransaction } from './wager-transaction';
import { WagerSettlement, type ReferenceLookup } from './wager-settlement';

const settlement = new WagerSettlement(ReferenceRetryPolicy.create({ maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10_000 }));

const found = (transaction: WagerTransaction, alreadyReversed = false): ReferenceLookup => ({
  found: true,
  transaction,
  alreadyReversed,
});

function processed(wallet: Wallet, kind: K, amount: string, ref?: WagerTransaction): WagerTransaction {
  const tx = wager(wallet, kind, amount, ref ? { referenceExternalTransactionId: ref.externalTransactionId } : {});
  const outcome = settlement.settle({ transaction: tx, wallet, reference: ref && found(ref), at: AT });
  expect(outcome.status).toBe(S.Processed);
  return tx;
}

describe('WagerSettlement', () => {
  let wallet: Wallet;
  beforeEach(() => {
    wallet = openWallet('100.00');
  });

  describe('BET', () => {
    it('debita e gera 1 lançamento DEBIT', () => {
      const tx = wager(wallet, K.Bet, '25.00');
      const outcome = settlement.settle({ transaction: tx, wallet, at: AT });
      expect(outcome.status).toBe(S.Processed);
      if (outcome.status !== S.Processed) return;
      expect(outcome.entry?.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.equals(brl('75.00'))).toBe(true);
      expect(tx.resultingBalance?.equals(brl('75.00'))).toBe(true);
    });

    it('cenário obrigatório: 100.00 com duas apostas de 80.00 → uma PROCESSED, outra INSUFFICIENT_FUNDS, saldo 20.00', () => {
      const a = wager(wallet, K.Bet, '80.00');
      const b = wager(wallet, K.Bet, '80.00');
      const ra = settlement.settle({ transaction: a, wallet, at: AT });
      const rb = settlement.settle({ transaction: b, wallet, at: AT });
      expect(ra.status).toBe(S.Processed);
      expect(rb).toEqual({ status: S.Rejected, failureCode: FailureCode.InsufficientFunds });
      expect(wallet.balance.equals(brl('20.00'))).toBe(true);
      expect(b.resultingBalance?.equals(brl('20.00'))).toBe(true);
      expect(wallet.version).toBe(2);
    });
  });

  describe('WIN', () => {
    it('credita sem referência', () => {
      processed(wallet, K.Win, '50.00');
      expect(wallet.balance.equals(brl('150.00'))).toBe(true);
    });

    it('credita referenciando a BET da mesma rodada', () => {
      const bet = processed(wallet, K.Bet, '10.00');
      const win = processed(wallet, K.Win, '30.00', bet);
      expect(win.referenceTransactionId).toBe(bet.id);
      expect(wallet.balance.equals(brl('120.00'))).toBe(true);
    });
  });

  describe('LOSS', () => {
    it('registra resultado sem mover saldo nem gerar lançamento', () => {
      const bet = processed(wallet, K.Bet, '10.00');
      const versionBefore = wallet.version;
      const loss = wager(wallet, K.Loss, '0.00', { referenceExternalTransactionId: bet.externalTransactionId });
      const outcome = settlement.settle({ transaction: loss, wallet, reference: found(bet), at: AT });
      expect(outcome).toEqual({ status: S.Processed, entry: undefined });
      expect(wallet.version).toBe(versionBefore);
      expect(wallet.balance.equals(brl('90.00'))).toBe(true);
    });
  });

  describe('REFUND', () => {
    it('credita o valor da BET', () => {
      const bet = processed(wallet, K.Bet, '40.00');
      processed(wallet, K.Refund, '40.00', bet);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });

    it('só pode referenciar BET', () => {
      const win = processed(wallet, K.Win, '10.00');
      const refund = wager(wallet, K.Refund, '10.00', { referenceExternalTransactionId: win.externalTransactionId });
      expect(settlement.settle({ transaction: refund, wallet, reference: found(win), at: AT })).toEqual({
        status: S.Rejected,
        failureCode: FailureCode.ReferenceKindNotAllowed,
      });
    });

    it('não reverte duas vezes', () => {
      const bet = processed(wallet, K.Bet, '40.00');
      const refund = wager(wallet, K.Refund, '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
      expect(settlement.settle({ transaction: refund, wallet, reference: found(bet, true), at: AT })).toEqual({
        status: S.Rejected,
        failureCode: FailureCode.ReferenceAlreadyReversed,
      });
    });

    it('valor diferente da referência é rejeitado (reversão parcial fora de escopo)', () => {
      const bet = processed(wallet, K.Bet, '40.00');
      const refund = wager(wallet, K.Refund, '39.99', { referenceExternalTransactionId: bet.externalTransactionId });
      expect(settlement.settle({ transaction: refund, wallet, reference: found(bet), at: AT })).toEqual({
        status: S.Rejected,
        failureCode: FailureCode.ReferenceAmountMismatch,
      });
    });

    it('referência REJECTED não pode ser revertida', () => {
      const bet = wager(wallet, K.Bet, '500.00');
      settlement.settle({ transaction: bet, wallet, at: AT }); // rejeitada por saldo
      const refund = wager(wallet, K.Refund, '500.00', { referenceExternalTransactionId: bet.externalTransactionId });
      expect(settlement.settle({ transaction: refund, wallet, reference: found(bet), at: AT })).toEqual({
        status: S.Rejected,
        failureCode: FailureCode.ReferenceNotProcessed,
      });
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });
  });

  describe('ROLLBACK', () => {
    it('de BET credita', () => {
      const bet = processed(wallet, K.Bet, '30.00');
      processed(wallet, K.Rollback, '30.00', bet);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });

    it('de WIN debita', () => {
      const win = processed(wallet, K.Win, '30.00');
      processed(wallet, K.Rollback, '30.00', win);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });

    it('de REFUND debita', () => {
      const bet = processed(wallet, K.Bet, '30.00');
      const refund = processed(wallet, K.Refund, '30.00', bet);
      processed(wallet, K.Rollback, '30.00', refund);
      expect(wallet.balance.equals(brl('70.00'))).toBe(true);
    });

    it('de LOSS não é permitido', () => {
      const loss = processed(wallet, K.Loss, '0.00');
      const rb = wager(wallet, K.Rollback, '1.00', { referenceExternalTransactionId: loss.externalTransactionId });
      expect(settlement.settle({ transaction: rb, wallet, reference: found(loss), at: AT })).toEqual({
        status: S.Rejected,
        failureCode: FailureCode.ReferenceKindNotAllowed,
      });
    });

    it('que deixaria saldo negativo é rejeitado com código distinto de aposta sem saldo', () => {
      const win = processed(wallet, K.Win, '50.00'); // saldo 150
      processed(wallet, K.Bet, '120.00'); // saldo 30
      const rb = wager(wallet, K.Rollback, '50.00', { referenceExternalTransactionId: win.externalTransactionId });
      const outcome = settlement.settle({ transaction: rb, wallet, reference: found(win), at: AT });
      expect(outcome).toEqual({ status: S.Rejected, failureCode: FailureCode.ReversalInsufficientFunds });
      expect(rb.resultingBalance?.equals(brl('30.00'))).toBe(true);
      expect(wallet.balance.equals(brl('30.00'))).toBe(true);
    });
  });

  describe('vínculo da referência', () => {
    it.each([
      ['rodada diferente', { roundId: 'round-2' }],
      ['provider diferente', { providerId: 'provider-b' }],
    ])('%s → REFERENCE_MISMATCH', (_label, overrides) => {
      const bet = processed(wallet, K.Bet, '10.00');
      const refund = wager(wallet, K.Refund, '10.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
        ...overrides,
      });
      expect(settlement.settle({ transaction: refund, wallet, reference: found(bet), at: AT })).toEqual({
        status: S.Rejected,
        failureCode: FailureCode.ReferenceMismatch,
      });
    });
  });

  describe('referência fora de ordem', () => {
    it('referência ausente → PENDING_REFERENCE com backoff exponencial, depois REFERENCE_NOT_FOUND', () => {
      const rb = wager(wallet, K.Rollback, '10.00', { referenceExternalTransactionId: 'bet-que-ainda-nao-chegou' });
      const delays: number[] = [];
      for (let i = 0; i < 3; i++) {
        const outcome = settlement.settle({ transaction: rb, wallet, reference: { found: false }, at: AT });
        expect(outcome.status).toBe(S.PendingReference);
        if (outcome.status === S.PendingReference) delays.push(outcome.nextAttemptAt.getTime() - AT.getTime());
      }
      expect(delays).toEqual([1000, 2000, 4000]);

      const final = settlement.settle({ transaction: rb, wallet, reference: { found: false }, at: AT });
      expect(final).toEqual({ status: S.Rejected, failureCode: FailureCode.ReferenceNotFound });
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });

    it('referência chega depois → processa normalmente', () => {
      const bet = wager(wallet, K.Bet, '10.00');
      const rb = wager(wallet, K.Rollback, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
      expect(settlement.settle({ transaction: rb, wallet, reference: { found: false }, at: AT }).status).toBe(
        S.PendingReference,
      );

      settlement.settle({ transaction: bet, wallet, at: AT });
      expect(settlement.settle({ transaction: rb, wallet, reference: found(bet), at: AT }).status).toBe(S.Processed);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });

    it('referência ainda não terminal é tratada como pendente', () => {
      const bet = wager(wallet, K.Bet, '10.00'); // PENDING
      const refund = wager(wallet, K.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
      expect(settlement.settle({ transaction: refund, wallet, reference: found(bet), at: AT }).status).toBe(
        S.PendingReference,
      );
    });
  });

  describe('vínculo com a wallet', () => {
    it('wallet inexistente → WALLET_NOT_FOUND', () => {
      const tx = wager(wallet, K.Bet, '1.00');
      expect(settlement.settle({ transaction: tx, wallet: undefined, at: AT })).toEqual({
        status: S.Rejected,
        failureCode: FailureCode.WalletNotFound,
      });
    });

    it('player diferente do dono da wallet → WALLET_PLAYER_MISMATCH', () => {
      const tx = wager(wallet, K.Bet, '1.00', { playerId: newId() });
      expect(settlement.settle({ transaction: tx, wallet, at: AT })).toEqual({
        status: S.Rejected,
        failureCode: FailureCode.WalletPlayerMismatch,
      });
    });

    it('moeda diferente da wallet → CURRENCY_MISMATCH, sem alterar saldo', () => {
      const tx = wager(wallet, K.Bet, '1.00', { money: Money.from({ amount: '1.00', currency: 'USD' }) });
      expect(settlement.settle({ transaction: tx, wallet, at: AT })).toEqual({
        status: S.Rejected,
        failureCode: FailureCode.CurrencyMismatch,
      });
      expect(wallet.version).toBe(1);
    });
  });
});
