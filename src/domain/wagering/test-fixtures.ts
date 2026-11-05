import { newId } from '../shared/id';
import { Money } from '../shared/money';
import { Wallet } from '../wallet/wallet';
import { WagerTransaction, WagerTransactionKind, type CreateWagerTransactionProps } from './wager-transaction';

export const AT = new Date('2026-11-05T12:00:00.000Z');
export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const HASH = 'a'.repeat(64);

export function openWallet(initial = '100.00', playerId = newId()): Wallet {
  return Wallet.open({ id: newId(), playerId, initialBalance: brl(initial), openingTransactionId: newId(), at: AT }).wallet;
}

let seq = 0;

export function wager(
  wallet: Wallet,
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${++seq}`;
  return WagerTransaction.create({
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: HASH,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    createdAt: AT,
    ...overrides,
  });
}
