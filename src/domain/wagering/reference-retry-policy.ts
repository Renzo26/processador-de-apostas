export interface ReferenceRetryPolicyProps {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Backoff exponencial para transações aguardando a referência.
 *
 * Default: 10 tentativas, 1s → 2s → 4s … limitado a 5 min por espera.
 * Janela total ≈ 13,5 min. Provedores costumam entregar a operação referenciada
 * em segundos; a janela cobre indisponibilidades curtas do broker sem manter
 * transações penduradas indefinidamente.
 */
export class ReferenceRetryPolicy {
  private constructor(private readonly props: ReferenceRetryPolicyProps) {}

  static create(props: Partial<ReferenceRetryPolicyProps> = {}): ReferenceRetryPolicy {
    const resolved: ReferenceRetryPolicyProps = {
      maxAttempts: props.maxAttempts ?? 10,
      baseDelayMs: props.baseDelayMs ?? 1_000,
      maxDelayMs: props.maxDelayMs ?? 5 * 60_000,
    };
    if (resolved.maxAttempts < 1 || resolved.baseDelayMs < 1 || resolved.maxDelayMs < resolved.baseDelayMs) {
      throw new Error('Invalid ReferenceRetryPolicy configuration');
    }
    return new ReferenceRetryPolicy(resolved);
  }

  get maxAttempts(): number {
    return this.props.maxAttempts;
  }

  /** `attemptsSoFar` = quantas vezes a transação já foi colocada em PENDING_REFERENCE. */
  isExhausted(attemptsSoFar: number): boolean {
    return attemptsSoFar >= this.props.maxAttempts;
  }

  nextAttemptAt(attemptsSoFar: number, now: Date): Date {
    const delay = Math.min(this.props.baseDelayMs * 2 ** attemptsSoFar, this.props.maxDelayMs);
    return new Date(now.getTime() + delay);
  }
}
