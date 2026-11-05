import { newId } from '../shared/id';
import type { Money } from '../shared/money';
import { LedgerDirection } from './ledger-direction';
import { InvalidLedgerEntryError } from './wallet.errors';

export interface CreateLedgerEntryProps {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  createdAt: Date;
}

export interface LedgerEntryState extends Omit<CreateLedgerEntryProps, 'createdAt'> {
  id: string;
  balanceAfter: Money;
  createdAt: Date;
}

/**
 * Lançamento imutável do ledger. Sem setters, sem métodos de transição:
 * todos os campos são `readonly` e a instância é congelada.
 * O banco reforça a imutabilidade com trigger que bloqueia UPDATE/DELETE.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Calcula `balanceAfter` e valida a aritmética do lançamento. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError('Ledger entry amount must be positive');
    }
    const balanceAfter =
      props.direction === LedgerDirection.Credit
        ? props.balanceBefore.add(props.money)
        : props.balanceBefore.subtract(props.money);

    if (balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('Ledger entry would produce a negative balance');
    }

    const entry = new WalletLedgerEntry(
      newId(props.createdAt.getTime()),
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      balanceAfter,
      new Date(props.createdAt),
    );
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      new Date(state.createdAt),
    );
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Efeito com sinal no saldo: +money para crédito, -money para débito. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }
}
