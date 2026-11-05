import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './domain-error';

export interface MoneyProps {
  amount: string; // decimal string com escala 2, ex.: "25.00"
  currency: string; // ISO-4217
}

/** Instância isolada do decimal.js: não depende da configuração global. */
const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

const SCALE = 2;
/** Compatível com a coluna NUMERIC(20, 2): até 18 dígitos inteiros. */
const MAX_INTEGER_DIGITS = 18;
/** Sem sinal, sem notação científica, sem zeros à esquerda, no máximo 2 casas. */
const AMOUNT_PATTERN = new RegExp(`^(0|[1-9]\\d{0,${MAX_INTEGER_DIGITS - 1}})(\\.\\d{1,${SCALE}})?$`);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Value object monetário imutável. Nunca usa `number`: a aritmética é exata
 * (decimal.js) e a serialização é sempre uma string com escala fixa de 2 casas.
 *
 * Não há arredondamento implícito: valores com mais de 2 casas são rejeitados
 * na entrada, e soma/subtração de valores com escala 2 nunca geram casas extras.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /** Contrato de entrada: rejeita valores negativos e formatos ambíguos. */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('Money must be an object with amount and currency');
    }
    const { amount, currency } = props;
    Money.assertCurrency(currency);
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `Invalid amount "${String(amount)}": expected a non-negative decimal string with at most ${SCALE} decimal places`,
      );
    }
    return new Money(new Dec(amount), currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(new Dec(0), currency);
  }

  /**
   * Reconstrução a partir da persistência (NUMERIC sempre chega como string).
   * Aceita valor negativo para permitir representar deltas, mas mantém a
   * mesma exigência de formato exato.
   */
  static rehydrate(props: MoneyProps): Money {
    const negative = props.amount.startsWith('-');
    const money = Money.from({ amount: negative ? props.amount.slice(1) : props.amount, currency: props.currency });
    return negative ? money.negate() : money;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toFixedAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.toFixedAmount()} ${this.currency}`;
  }

  /** Valor decimal com escala fixa, ex.: "25.00" — usado na persistência. */
  toFixedAmount(): string {
    // -0 vira "0.00": zero não tem sinal.
    return this.value.isZero() ? (0).toFixed(SCALE) : this.value.toFixed(SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency "${String(currency)}": expected ISO-4217 code`);
    }
  }
}
