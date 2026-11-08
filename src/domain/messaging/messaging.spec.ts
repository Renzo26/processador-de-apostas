import { describe, expect, it } from 'bun:test';
import { computePayloadHash, canonicalJson } from '../../application/wagering/payload-hash';
import { WalletBalanceChanged, WagerTransactionProcessed } from '../events/wagering-events';
import { AT, brl, openWallet, wager } from '../wagering/test-fixtures';
import { WagerTransactionKind } from '../wagering/wager-transaction';
import { InboxMessage } from './inbox-message';
import { OutboxMessage } from './outbox-message';

const ctx = { correlationId: 'corr-1', causationId: 'msg-1', at: AT };

describe('IntegrationEvent', () => {
  it('serializa envelope com eventType/version vindos do tipo e Money como string decimal', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit({ money: brl('25.00'), transactionId: 'tx-1', at: AT });
    const json = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.occurredAt).toBe(AT.toISOString());
    expect(json.data.balanceAfter).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(json.data.walletVersion).toBe(2);
    // round-trip JSON estável
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it('WagerTransactionProcessed carrega o saldo resultante', () => {
    const wallet = openWallet('100.00');
    const tx = wager(wallet, WagerTransactionKind.Loss, '0.00');
    tx.markProcessed(undefined, wallet.balance, AT);
    const json = WagerTransactionProcessed.from(tx, ctx).toJSON();
    expect(json.aggregateId).toBe(tx.id);
    expect(json.data.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  });
});

describe('OutboxMessage', () => {
  const event = () => {
    const wallet = openWallet('100.00');
    const entry = wallet.credit({ money: brl('1.00'), transactionId: 'tx', at: AT });
    return WalletBalanceChanged.from(wallet, entry, ctx);
  };

  it('usa o eventId como id e nasce pendente e devido', () => {
    const e = event();
    const msg = OutboxMessage.enqueue(e);
    expect(msg.id).toBe(e.eventId);
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(AT)).toBe(true);
    expect(msg.payload['eventType']).toBe('WalletBalanceChanged');
  });

  it('scheduleRetry aplica backoff exponencial com teto', () => {
    const msg = OutboxMessage.enqueue(event());
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) {
      msg.scheduleRetry(AT, 'boom');
      delays.push(msg.nextAttemptAt!.getTime() - AT.getTime());
    }
    expect(delays.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    expect(Math.max(...delays)).toBe(300_000);
    expect(msg.attempts).toBe(12);
    expect(msg.isDue(AT)).toBe(false);
  });

  it('markPublished é idempotente', () => {
    const msg = OutboxMessage.enqueue(event());
    msg.markPublished(AT);
    msg.markPublished(new Date(AT.getTime() + 1000));
    expect(msg.publishedAt).toEqual(AT);
    expect(msg.isDue(AT)).toBe(false);
  });
});

describe('InboxMessage', () => {
  it('markProcessed é idempotente', () => {
    const inbox = InboxMessage.receive({ messageId: 'm', consumerName: 'c', payloadHash: 'h', receivedAt: AT });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(AT);
    inbox.markProcessed(new Date(0));
    expect(inbox.processedAt).toEqual(AT);
  });
});

describe('payloadHash', () => {
  const base = {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: 'p',
    walletId: 'w',
    roundId: 'r',
    gameId: 'g',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };

  it('JSON canônico ordena chaves recursivamente e omite undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: undefined, b: 2 } })).toBe('{"a":{"b":2,"d":1},"b":1}');
  });

  it('independe da ordem das chaves e da escala informada', () => {
    const reordered = { ...base, money: { currency: 'BRL', amount: '25' } };
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(base));
  });

  it('mesma key com payload divergente produz hash diferente', () => {
    expect(computePayloadHash({ ...base, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(computePayloadHash(base));
    expect(computePayloadHash({ ...base, referenceExternalTransactionId: 'x' })).not.toBe(computePayloadHash(base));
  });

  it('é um SHA-256 hex', () => {
    expect(computePayloadHash(base)).toMatch(/^[a-f0-9]{64}$/);
  });
});
