import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from './domain-error';
import { Money } from './money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  describe('from', () => {
    it.each([
      ['25.00', '25.00'],
      ['25', '25.00'],
      ['25.5', '25.50'],
      ['0', '0.00'],
      ['0.01', '0.01'],
      ['999999999999999999.99', '999999999999999999.99'],
    ])('aceita "%s" e serializa com escala fixa como "%s"', (input, expected) => {
      expect(brl(input).toJSON()).toEqual({ amount: expected, currency: 'BRL' });
    });

    it.each([
      ['string vazia', ''],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['notação científica', '1e3'],
      ['notação científica decimal', '2.5E1'],
      ['mais de 2 casas', '25.001'],
      ['negativo', '-25.00'],
      ['sinal positivo explícito', '+25.00'],
      ['zeros à esquerda', '025.00'],
      ['ponto sem casas', '25.'],
      ['sem parte inteira', '.50'],
      ['vírgula decimal', '25,00'],
      ['espaços', ' 25.00 '],
      ['hexadecimal', '0x10'],
      ['acima de NUMERIC(20,2)', '1000000000000000000.00'],
    ])('rejeita %s ("%s")', (_label, amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    });

    it('rejeita amount numérico (number nunca é aceito como dinheiro)', () => {
      expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    });

    it.each(['', 'brl', 'BR', 'REAL', '123'])('rejeita moeda inválida "%s"', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    });
  });

  describe('aritmética exata', () => {
    it('0.10 + 0.20 === 0.30 (sem erro de ponto flutuante)', () => {
      expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
    });

    it('subtrai preservando escala', () => {
      expect(brl('100.00').subtract(brl('80.00')).toJSON().amount).toBe('20.00');
    });

    it('subtração pode produzir valor negativo (a invariante de saldo é da Wallet)', () => {
      const result = brl('20.00').subtract(brl('80.00'));
      expect(result.isNegative()).toBe(true);
      expect(result.toJSON().amount).toBe('-60.00');
    });

    it('negate inverte o sinal e zero permanece sem sinal', () => {
      expect(brl('25.00').negate().toJSON().amount).toBe('-25.00');
      expect(brl('0').negate().toJSON().amount).toBe('0.00');
    });

    it('soma de valores grandes não perde precisão', () => {
      const big = brl('999999999999999.99');
      expect(big.add(brl('0.01')).toJSON().amount).toBe('1000000000000000.00');
    });

    it('é imutável: operações retornam novas instâncias', () => {
      const original = brl('10.00');
      const sum = original.add(brl('5.00'));
      expect(original.toJSON().amount).toBe('10.00');
      expect(sum).not.toBe(original);
    });
  });

  describe('comparações', () => {
    it('isZero / isPositive / isNegative', () => {
      expect(Money.zero('BRL').isZero()).toBe(true);
      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('0.01').negate().isNegative()).toBe(true);
    });

    it('isLessThan', () => {
      expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
      expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    });

    it('equals considera valor e moeda', () => {
      expect(brl('25').equals(brl('25.00'))).toBe(true);
      expect(brl('25.00').equals(Money.from({ amount: '25.00', currency: 'USD' }))).toBe(false);
    });
  });

  describe('conflito de moeda', () => {
    const usd = Money.from({ amount: '10.00', currency: 'USD' });

    it.each([
      ['add', () => brl('10.00').add(usd)],
      ['subtract', () => brl('10.00').subtract(usd)],
      ['isLessThan', () => brl('10.00').isLessThan(usd)],
    ])('%s entre moedas diferentes lança CurrencyMismatchError', (_op, fn) => {
      expect(fn).toThrow(CurrencyMismatchError);
    });
  });

  describe('rehydrate', () => {
    it('reconstrói valores vindos do banco, inclusive negativos (deltas)', () => {
      expect(Money.rehydrate({ amount: '975.00', currency: 'BRL' }).toJSON().amount).toBe('975.00');
      expect(Money.rehydrate({ amount: '-25.00', currency: 'BRL' }).toJSON().amount).toBe('-25.00');
    });
  });

  it('toString é legível para logs/erros', () => {
    expect(brl('25').toString()).toBe('25.00 BRL');
  });
});
