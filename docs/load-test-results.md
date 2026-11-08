# Resultado do teste de carga

Gerado em 2026-11-08T20:48:19.062Z por `bun run test:load`.

## Ambiente

| Item | Valor |
|---|---|
| Máquina | Apple M5 (10 núcleos), 16 GB RAM |
| Sistema | Darwin 25.6.0 (arm64) |
| Bun (cliente) | 1.4.2 |
| Topologia | 3 instâncias da aplicação + nginx (round-robin) + PostgreSQL 17 + LocalStack, todos em Docker na mesma máquina do cliente |
| Pool por instância | DB_POOL_MAX=20 |
| Carga | modelo fechado, 50 usuários virtuais, 20 s por cenário |
| Alvo | http://localhost:8080 |

## Resumo

| Cenário | Requisições | Throughput | p50 | p95 | p99 | máx | Taxa de erro |
|---|---|---|---|---|---|---|---|
| Cenário A: wallets distribuídas | 61034 | **3051.7 req/s** | 14.4 ms | 31.4 ms | 47.3 ms | 236.0 ms | 0.00% (0) |
| Cenário B: hot wallet | 8505 | **425.3 req/s** | 64.1 ms | 415.3 ms | 699.5 ms | 1978.4 ms | 0.00% (0) |

## Cenário A: wallets distribuídas

200 wallets. Mistura: 70% BET, 20% WIN e 10% replays (reenvio idêntico de uma requisição já processada). Representa o tráfego normal: muitos jogadores, cada um com poucas operações simultâneas.

| Resultado | Quantidade |
|---|---|
| 201 processadas | 54913 |
| 200 replays idempotentes | 6121 |
| 422 rejeitadas por regra (esperado, não é erro) | 0 |
| 409 conflitos | 0 |
| 4xx inesperados | 0 |
| 5xx | 0 |
| erros de rede | 0 |

| Métrica (soma das 3 instâncias, durante o cenário) | Valor |
|---|---|
| `wager_lock_conflicts_total` (corridas resolvidas pelo banco) | 0 |
| `wager_retries_total` | 0 |
| `wager_duplicates_detected_total` | 6121 |
| Outbox: pico de eventos pendentes | 42262 |
| Outbox: pico de lag (idade do evento mais antigo) | 7.11 s |
| Outbox: tempo para esvaziar após a carga | 5.64 s |
| Consistência saldo × ledger | 200/200 wallets consistentes |

## Cenário B: hot wallet

Todas as 50 conexões apostando na MESMA wallet (100% BET). Pior caso para o lock pessimista: as operações dessa wallet são serializadas.

| Resultado | Quantidade |
|---|---|
| 201 processadas | 8505 |
| 200 replays idempotentes | 0 |
| 422 rejeitadas por regra (esperado, não é erro) | 0 |
| 409 conflitos | 0 |
| 4xx inesperados | 0 |
| 5xx | 0 |
| erros de rede | 0 |

| Métrica (soma das 3 instâncias, durante o cenário) | Valor |
|---|---|
| `wager_lock_conflicts_total` (corridas resolvidas pelo banco) | 0 |
| `wager_retries_total` | 0 |
| `wager_duplicates_detected_total` | 0 |
| Outbox: pico de eventos pendentes | 124 |
| Outbox: pico de lag (idade do evento mais antigo) | 0.13 s |
| Outbox: tempo para esvaziar após a carga | 0.20 s |
| Consistência saldo × ledger | 1/1 wallets consistentes |

