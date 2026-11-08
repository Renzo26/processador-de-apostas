export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date | undefined;
}

/**
 * Registro de deduplicação de mensagens recebidas, chave (consumerName, messageId).
 * Gravado na MESMA transação SQL do efeito financeiro: se o commit acontece,
 * a mensagem está marcada; se não, o redelivery reprocessa do zero.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (!props.messageId || !props.consumerName) {
      throw new Error('InboxMessage requires messageId and consumerName');
    }
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, new Date(props.receivedAt), undefined);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      new Date(state.receivedAt),
      state.processedAt && new Date(state.processedAt),
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this._processedAt) return; // idempotente
    this._processedAt = new Date(at);
  }
}
