/**
 * Teste de carga contra a stack real (3 instâncias + nginx + PostgreSQL + LocalStack).
 *
 * Pré-requisito: docker compose --profile app up -d --build
 * Uso:           bun run test:load            (variáveis abaixo são opcionais)
 *
 *   LOAD_API=http://localhost:8080  LOAD_DURATION_S=20  LOAD_CONCURRENCY=50  LOAD_WALLETS=200
 *
 * Metodologia (modelo fechado): N usuários virtuais em laço, cada um envia a próxima
 * requisição assim que recebe a resposta anterior, durante D segundos por cenário.
 * Mede latência ponta a ponta no cliente (inclui nginx), classifica cada resposta,
 * amostra a outbox no banco a cada segundo e, ao final, coleta métricas das 3
 * instâncias e verifica a consistência de TODAS as wallets usadas.
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { buildOrmConfig } from '../src/infrastructure/database/mikro-orm.config';

const API = process.env.LOAD_API ?? 'http://localhost:8080';
const DURATION_S = Number(process.env.LOAD_DURATION_S ?? 20);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 50);
const WALLETS = Number(process.env.LOAD_WALLETS ?? 200);
const INSTANCES = ['app-1', 'app-2', 'app-3'];

type Outcome = 'processed' | 'replay' | 'rejected' | 'conflict' | 'client_error' | 'server_error' | 'network_error';

interface Wallet {
  id: string;
  playerId: string;
}

interface ScenarioResult {
  name: string;
  description: string;
  durationS: number;
  concurrency: number;
  latenciesMs: number[];
  outcomes: Record<Outcome, number>;
  outboxSamples: Array<{ pending: number; ageS: number }>;
  outboxDrainS: number;
  metricsDelta: Record<string, number>;
  wallets: Wallet[];
  consistency: { checked: number; inconsistent: number };
}

const RUN = Date.now().toString(36);
let seq = 0;

// ------------------------------------------------------------------ helpers HTTP

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function createWallet(amount: string): Promise<Wallet> {
  const res = await post('/wallets', { playerId: crypto.randomUUID(), initialBalance: { amount, currency: 'BRL' } });
  if (res.status !== 201) throw new Error(`createWallet failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: String(res.body.id), playerId: String(res.body.playerId) };
}

interface Wager {
  key: string;
  body: Record<string, unknown>;
}

function wager(wallet: Wallet, kind: 'BET' | 'WIN', amount: string): Wager {
  const ext = `load-${RUN}-${++seq}`;
  return {
    key: `provider-load:${ext}`,
    body: {
      providerId: 'provider-load',
      externalTransactionId: ext,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${seq % 1000}`,
      gameId: 'load-test',
      kind,
      money: { amount, currency: 'BRL' },
    },
  };
}

async function send(w: Wager): Promise<{ outcome: Outcome; ms: number }> {
  const started = performance.now();
  try {
    const res = await fetch(API + '/wagering/transactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': w.key },
      body: JSON.stringify(w.body),
    });
    const json = (await res.json()) as { idempotentReplay?: boolean };
    const ms = performance.now() - started;
    if (res.status === 201) return { outcome: 'processed', ms };
    if (res.status === 200 && json.idempotentReplay) return { outcome: 'replay', ms };
    if (res.status === 422) return { outcome: 'rejected', ms };
    if (res.status === 409) return { outcome: 'conflict', ms };
    if (res.status >= 500) return { outcome: 'server_error', ms };
    return { outcome: 'client_error', ms };
  } catch {
    return { outcome: 'network_error', ms: performance.now() - started };
  }
}

// ------------------------------------------------------------------ métricas e banco

/** Lê /metrics de cada instância diretamente (o balanceador esconderia de qual instância veio). */
async function scrapeInstances(): Promise<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const instance of INSTANCES) {
    const proc = Bun.spawn(['docker', 'compose', 'exec', '-T', instance, 'wget', '-qO-', 'http://localhost:3000/metrics'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of text.split('\n')) {
      const m = /^(wager_lock_conflicts_total|wager_retries_total|wager_duplicates_detected_total|wager_transactions_total)(\{[^}]*\})?\s+([\d.e+-]+)$/.exec(line);
      if (!m) continue;
      const key = m[1]!;
      totals[key] = (totals[key] ?? 0) + Number(m[3]);
    }
  }
  return totals;
}

function delta(after: Record<string, number>, before: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(after), ...Object.keys(before)])) out[k] = (after[k] ?? 0) - (before[k] ?? 0);
  return out;
}

async function outboxStats(orm: MikroORM) {
  const [row] = await orm.em.fork().execute<{ pending: number; age: number }[]>(
    `SELECT count(*)::int AS pending, COALESCE(EXTRACT(EPOCH FROM now() - min(occurred_at)), 0)::float AS age
       FROM outbox_messages WHERE published_at IS NULL`,
  );
  return { pending: row!.pending, ageS: Number(row!.age) };
}

async function checkConsistency(wallets: Wallet[]) {
  let inconsistent = 0;
  for (let i = 0; i < wallets.length; i += 20) {
    const results = await Promise.all(
      wallets.slice(i, i + 20).map((w) => post(`/wallets/${w.id}/reconciliation`, {})),
    );
    inconsistent += results.filter((r) => r.body.consistent !== true).length;
  }
  return { checked: wallets.length, inconsistent };
}

// ------------------------------------------------------------------ execução de cenário

async function runScenario(
  orm: MikroORM,
  name: string,
  description: string,
  wallets: Wallet[],
  nextRequest: (history: Wager[]) => Wager,
): Promise<ScenarioResult> {
  process.stdout.write(`\n▶ ${name}: ${CONCURRENCY} usuários virtuais por ${DURATION_S}s… `);
  const metricsBefore = await scrapeInstances();
  const latenciesMs: number[] = [];
  const outcomes: Record<Outcome, number> = {
    processed: 0, replay: 0, rejected: 0, conflict: 0, client_error: 0, server_error: 0, network_error: 0,
  };
  const history: Wager[] = [];
  const outboxSamples: Array<{ pending: number; ageS: number }> = [];

  const deadline = performance.now() + DURATION_S * 1000;
  const sampler = setInterval(() => {
    void outboxStats(orm).then((s) => outboxSamples.push(s));
  }, 1000);

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (performance.now() < deadline) {
        const w = nextRequest(history);
        const { outcome, ms } = await send(w);
        outcomes[outcome]++;
        latenciesMs.push(ms);
        if (outcome === 'processed' && history.length < 5000) history.push(w);
      }
    }),
  );
  clearInterval(sampler);

  // Tempo até a outbox esvaziar depois do fim da carga
  const drainStart = performance.now();
  while ((await outboxStats(orm)).pending > 0 && performance.now() - drainStart < 60_000) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const outboxDrainS = (performance.now() - drainStart) / 1000;
  const metricsDelta = delta(await scrapeInstances(), metricsBefore);
  const consistency = await checkConsistency(wallets);
  process.stdout.write('ok\n');

  return { name, description, durationS: DURATION_S, concurrency: CONCURRENCY, latenciesMs, outcomes, outboxSamples, outboxDrainS, metricsDelta, wallets, consistency };
}

// ------------------------------------------------------------------ relatório

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function summarize(r: ScenarioResult) {
  const sorted = [...r.latenciesMs].sort((a, b) => a - b);
  const total = r.latenciesMs.length;
  const errors = r.outcomes.server_error + r.outcomes.network_error + r.outcomes.client_error;
  return {
    total,
    rps: total / r.durationS,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? 0,
    errorRate: total ? errors / total : 0,
    errors,
    maxPending: Math.max(0, ...r.outboxSamples.map((s) => s.pending)),
    maxLag: Math.max(0, ...r.outboxSamples.map((s) => s.ageS)),
  };
}

const f = (n: number, d = 1) => n.toFixed(d);

function report(results: ScenarioResult[], env: Record<string, string>): string {
  const lines: string[] = [];
  lines.push(`# Resultado do teste de carga`, '', `Gerado em ${new Date().toISOString()} por \`bun run test:load\`.`, '');
  lines.push('## Ambiente', '', '| Item | Valor |', '|---|---|');
  for (const [k, v] of Object.entries(env)) lines.push(`| ${k} | ${v} |`);
  lines.push('');
  lines.push('## Resumo', '');
  lines.push('| Cenário | Requisições | Throughput | p50 | p95 | p99 | máx | Taxa de erro |', '|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const s = summarize(r);
    lines.push(`| ${r.name} | ${s.total} | **${f(s.rps)} req/s** | ${f(s.p50)} ms | ${f(s.p95)} ms | ${f(s.p99)} ms | ${f(s.max)} ms | ${f(s.errorRate * 100, 2)}% (${s.errors}) |`);
  }
  lines.push('');
  for (const r of results) {
    const s = summarize(r);
    const m = r.metricsDelta;
    lines.push(`## ${r.name}`, '', r.description, '');
    lines.push('| Resultado | Quantidade |', '|---|---|');
    lines.push(`| 201 processadas | ${r.outcomes.processed} |`);
    lines.push(`| 200 replays idempotentes | ${r.outcomes.replay} |`);
    lines.push(`| 422 rejeitadas por regra (esperado, não é erro) | ${r.outcomes.rejected} |`);
    lines.push(`| 409 conflitos | ${r.outcomes.conflict} |`);
    lines.push(`| 4xx inesperados | ${r.outcomes.client_error} |`);
    lines.push(`| 5xx | ${r.outcomes.server_error} |`);
    lines.push(`| erros de rede | ${r.outcomes.network_error} |`);
    lines.push('');
    lines.push('| Métrica (soma das 3 instâncias, durante o cenário) | Valor |', '|---|---|');
    lines.push(`| \`wager_lock_conflicts_total\` (corridas resolvidas pelo banco) | ${m.wager_lock_conflicts_total ?? 0} |`);
    lines.push(`| \`wager_retries_total\` | ${m.wager_retries_total ?? 0} |`);
    lines.push(`| \`wager_duplicates_detected_total\` | ${m.wager_duplicates_detected_total ?? 0} |`);
    lines.push(`| Outbox: pico de eventos pendentes | ${s.maxPending} |`);
    lines.push(`| Outbox: pico de lag (idade do evento mais antigo) | ${f(s.maxLag, 2)} s |`);
    lines.push(`| Outbox: tempo para esvaziar após a carga | ${f(r.outboxDrainS, 2)} s |`);
    lines.push(`| Consistência saldo × ledger | ${r.consistency.checked - r.consistency.inconsistent}/${r.consistency.checked} wallets consistentes |`);
    lines.push('');
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ main

async function main() {
  const health = await fetch(`${API}/health/ready`).catch(() => undefined);
  if (!health?.ok) {
    console.error(`API indisponível em ${API}. Suba a stack: docker compose --profile app up -d --build`);
    process.exit(1);
  }
  // O banco é acessado só para amostrar a outbox (leitura).
  const orm = await MikroORM.init(buildOrmConfig({ pool: { min: 1, max: 2 } }));

  try {
    process.stdout.write(`Criando ${WALLETS} wallets… `);
    const wallets: Wallet[] = [];
    for (let i = 0; i < WALLETS; i += 20) {
      wallets.push(...(await Promise.all(Array.from({ length: Math.min(20, WALLETS - i) }, () => createWallet('100000.00')))));
    }
    const hot = await createWallet('100000000.00');
    process.stdout.write('ok\n');

    const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;

    const distributed = await runScenario(
      orm,
      'Cenário A: wallets distribuídas',
      `${WALLETS} wallets. Mistura: 70% BET, 20% WIN e 10% replays (reenvio idêntico de uma requisição já processada). ` +
        'Representa o tráfego normal: muitos jogadores, cada um com poucas operações simultâneas.',
      wallets,
      (history) => {
        const r = Math.random();
        if (r < 0.1 && history.length > 0) return pick(history);
        return wager(pick(wallets), r < 0.8 ? 'BET' : 'WIN', '1.00');
      },
    );

    const hotWallet = await runScenario(
      orm,
      'Cenário B: hot wallet',
      `Todas as ${CONCURRENCY} conexões apostando na MESMA wallet (100% BET). ` +
        'Pior caso para o lock pessimista: as operações dessa wallet são serializadas.',
      [hot],
      () => wager(hot, 'BET', '1.00'),
    );

    const env = {
      'Máquina': `${os.cpus()[0]?.model ?? 'n/d'} (${os.cpus().length} núcleos), ${f(os.totalmem() / 1024 ** 3, 0)} GB RAM`,
      'Sistema': `${os.type()} ${os.release()} (${os.arch()})`,
      'Bun (cliente)': Bun.version,
      'Topologia': '3 instâncias da aplicação + nginx (round-robin) + PostgreSQL 17 + LocalStack, todos em Docker na mesma máquina do cliente',
      'Pool por instância': 'DB_POOL_MAX=20',
      'Carga': `modelo fechado, ${CONCURRENCY} usuários virtuais, ${DURATION_S} s por cenário`,
      'Alvo': API,
    };
    const md = report([distributed, hotWallet], env);
    mkdirSync('docs', { recursive: true });
    writeFileSync('docs/load-test-results.md', md + '\n');
    console.log('\n' + md);
    console.log('\nRelatório salvo em docs/load-test-results.md');

    const inconsistent = distributed.consistency.inconsistent + hotWallet.consistency.inconsistent;
    if (inconsistent > 0) {
      console.error(`\n✘ ${inconsistent} wallet(s) inconsistentes`);
      process.exit(1);
    }
  } finally {
    await orm.close();
  }
}

await main();
