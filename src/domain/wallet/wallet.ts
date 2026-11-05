import { CurrencyMismatchError } from '../shared/domain-error';
import type { Money } from '../shared/money';
import { LedgerDirection } from './ledger-direction';
import { WalletLedgerEntry } from './wallet-ledger-entry';
import { InsufficientFundsError, InvalidWalletError } from './wallet.errors';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Transação OPENING que justifica o crédito inicial no ledger. */
  openingTransactionId: string;
  at: Date;
}

export interface WalletOpening {
  wallet: Wallet;
  /** Presente apenas quando o saldo inicial é maior que zero. */
  openingEntry: WalletLedgerEntry | undefined;
}

export interface MovementProps {
  money: Money;
  transactionId: string;
  at: Date;
}

/**
 * Aggregate root da carteira.
 *
 * Toda alteração de saldo passa por `debit`/`credit`, que devolvem o lançamento
 * de ledger correspondente — não existe caminho que mude o saldo sem gerar
 * lançamento. `version` começa em 1 e só incrementa quando o saldo muda; é
 * usada como guarda de concorrência otimista na persistência, em complemento
 * ao lock pessimista da linha.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a carteira já com o saldo inicial. O crédito de abertura é registrado
   * no ledger (transação OPENING), mas não conta como mudança de versão: a
   * carteira nasce na versão 1 com o saldo inicial.
   */
  static open(props: OpenWalletProps): WalletOpening {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError('Initial balance cannot be negative');
    }
    const zero = props.initialBalance.subtract(props.initialBalance);
    const openingEntry = props.initialBalance.isPositive()
      ? WalletLedgerEntry.create({
          walletId: props.id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: props.initialBalance,
          balanceBefore: zero,
          createdAt: props.at,
        })
      : undefined;

    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      new Date(props.at),
      new Date(props.at),
    );
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** @throws InsufficientFundsError quando o saldo não cobre o débito. */
  debit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    if (!this.canDebit(props.money)) {
      throw new InsufficientFundsError(this.id, this._balance, props.money);
    }
    return this.apply(LedgerDirection.Debit, props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    return this.apply(LedgerDirection.Credit, props);
  }

  move(direction: LedgerDirection, props: MovementProps): WalletLedgerEntry {
    return direction === LedgerDirection.Debit ? this.debit(props) : this.credit(props);
  }

  private apply(direction: LedgerDirection, props: MovementProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this._balance,
      createdAt: props.at,
    });
    this._balance = entry.balanceAfter;
    this._version += 1;
    this._updatedAt = new Date(props.at);
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
