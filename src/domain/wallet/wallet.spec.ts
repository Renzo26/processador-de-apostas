import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError } from '../shared/domain-error';
import { newId } from '../shared/id';
import { Money } from '../shared/money';
import { LedgerDirection } from './ledger-direction';
import { Wallet } from './wallet';
import { WalletLedgerEntry } from './wallet-ledger-entry';
import { InsufficientFundsError, InvalidLedgerEntryError } from './wallet.errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-05T12:00:00.000Z');

function openWallet(initial = '100.00') {
  return Wallet.open({
    id: newId(),
    playerId: newId(),
    initialBalance: brl(initial),
    openingTransactionId: newId(),
    at,
  });
}

/** Invariante global: saldo materializado == saldo reconstruído pelo ledger. */
function replay(entries: WalletLedgerEntry[]): Money {
  return entries.reduce((acc, e) => acc.add(e.signedAmount()), Money.zero('BRL'));
}

describe('Wallet', () => {
  describe('open', () => {
    it('nasce na versão 1 com o saldo inicial e lançamento OPENING de crédito', () => {
      const { wallet, openingEntry } = openWallet('1000.00');
      expect(wallet.version).toBe(1);
      expect(wallet.balance.equals(brl('1000.00'))).toBe(true);
      expect(wallet.currency).toBe('BRL');
      expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
      expect(openingEntry?.balanceBefore.isZero()).toBe(true);
      expect(openingEntry?.balanceAfter.equals(brl('1000.00'))).toBe(true);
    });

    it('saldo inicial zero não gera lançamento', () => {
      const { wallet, openingEntry } = openWallet('0.00');
      expect(openingEntry).toBeUndefined();
      expect(wallet.balance.isZero()).toBe(true);
    });
  });

  describe('debit', () => {
    it('debita, incrementa a versão e devolve o lançamento correspondente', () => {
      const { wallet } = openWallet('100.00');
      const entry = wallet.debit({ money: brl('80.00'), transactionId: newId(), at });
      expect(wallet.balance.equals(brl('20.00'))).toBe(true);
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
      expect(entry.balanceAfter.equals(brl('20.00'))).toBe(true);
      expect(entry.isBalanced()).toBe(true);
    });

    it('permite debitar exatamente o saldo total', () => {
      const { wallet } = openWallet('80.00');
      wallet.debit({ money: brl('80.00'), transactionId: newId(), at });
      expect(wallet.balance.isZero()).toBe(true);
    });

    it('rejeita saldo insuficiente sem alterar estado (cenário 100 - 80 - 80)', () => {
      const { wallet } = openWallet('100.00');
      wallet.debit({ money: brl('80.00'), transactionId: newId(), at });
      expect(() => wallet.debit({ money: brl('80.00'), transactionId: newId(), at })).toThrow(InsufficientFundsError);
      expect(wallet.balance.equals(brl('20.00'))).toBe(true);
      expect(wallet.version).toBe(2);
    });
  });

  describe('credit', () => {
    it('credita e incrementa a versão', () => {
      const { wallet } = openWallet('10.00');
      const entry = wallet.credit({ money: brl('15.50'), transactionId: newId(), at });
      expect(wallet.balance.equals(brl('25.50'))).toBe(true);
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Credit);
    });
  });

  describe('conflito de moeda', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    it('debit/credit em moeda diferente lança CurrencyMismatchError sem alterar estado', () => {
      const { wallet } = openWallet('100.00');
      expect(() => wallet.debit({ money: usd, transactionId: newId(), at })).toThrow(CurrencyMismatchError);
      expect(() => wallet.credit({ money: usd, transactionId: newId(), at })).toThrow(CurrencyMismatchError);
      expect(wallet.version).toBe(1);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });
  });

  it('invariante: saldo materializado == saldo reconstruído pelo ledger', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    const entries = [openingEntry!];
    entries.push(wallet.debit({ money: brl('30.00'), transactionId: newId(), at }));
    entries.push(wallet.credit({ money: brl('45.25'), transactionId: newId(), at }));
    entries.push(wallet.debit({ money: brl('0.25'), transactionId: newId(), at }));
    expect(replay(entries).equals(wallet.balance)).toBe(true);
    expect(wallet.balance.equals(brl('115.00'))).toBe(true);
    expect(wallet.version).toBe(4);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    walletId: newId(),
    transactionId: newId(),
    balanceBefore: brl('50.00'),
    createdAt: at,
  };

  it('é estruturalmente imutável', () => {
    const entry = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('1.00') });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: Money }).balanceAfter = brl('999.00');
    }).toThrow();
  });

  it('rejeita valor zero', () => {
    expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('0') })).toThrow(
      InvalidLedgerEntryError,
    );
  });

  it('rejeita lançamento que deixaria o saldo negativo', () => {
    expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl('50.01') })).toThrow(
      InvalidLedgerEntryError,
    );
  });

  it('isBalanced detecta lançamento reidratado inconsistente', () => {
    const corrupted = WalletLedgerEntry.rehydrate({
      ...base,
      id: newId(),
      direction: LedgerDirection.Debit,
      money: brl('10.00'),
      balanceAfter: brl('45.00'),
    });
    expect(corrupted.isBalanced()).toBe(false);
  });
});
