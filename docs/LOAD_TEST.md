# Teste de carga

```bash
docker compose --profile app up -d --build   # 3 instâncias + nginx + PostgreSQL + LocalStack
bun run test:load                            # gera docs/load-test-results.md
```

Parâmetros opcionais: `LOAD_API` (padrão `http://localhost:8080`), `LOAD_DURATION_S` (20), `LOAD_CONCURRENCY` (50), `LOAD_WALLETS` (200).

O resultado bruto da última execução fica em [load-test-results.md](load-test-results.md). Este documento traz a metodologia e a análise.

---

## Ambiente

| Item | Valor |
|---|---|
| Máquina | Apple M5, 10 núcleos, 16 GB RAM (macOS 26, arm64) |
| Containers | OrbStack (Docker), **todos na mesma máquina do gerador de carga** |
| Topologia | 3 instâncias da aplicação → nginx (round-robin) → PostgreSQL 17 + LocalStack (SQS) |
| Configuração | `DB_POOL_MAX=20` por instância, `lock_timeout=5s`, `READ COMMITTED`, `OUTBOX_BATCH_SIZE=200` |

## Metodologia

- **Modelo fechado:** 50 usuários virtuais em laço; cada um envia a próxima requisição assim que recebe a resposta anterior. Duração de 20 s por cenário.
- **Latência** medida no cliente, ponta a ponta (inclui o nginx e a serialização JSON).
- **Classificação** de cada resposta: 201 processada, 200 replay, 422 rejeição de negócio (não conta como erro), 409, outros 4xx, 5xx e erro de rede. **Taxa de erro** = 5xx + rede + 4xx inesperados.
- **Outbox lag:** o script consulta o banco a cada segundo (quantidade de eventos pendentes e idade do mais antigo) e mede quanto tempo a outbox leva para esvaziar depois do fim da carga.
- **Conflitos de concorrência:** soma de `wager_lock_conflicts_total` e `wager_retries_total`, lidos diretamente de cada uma das 3 instâncias (via `docker compose exec`), antes e depois do cenário.
- **Consistência:** ao final, a reconciliação (`saldo == soma do ledger`) é executada para **todas** as wallets usadas. O script falha se alguma estiver inconsistente.

| Cenário | Descrição |
|---|---|
| **A: wallets distribuídas** | 200 wallets, 70% BET, 20% WIN, 10% replays (reenvio idêntico de uma requisição já processada). Tráfego normal: muitos jogadores. |
| **B: hot wallet** | As 50 conexões apostam na **mesma** wallet. Pior caso para o lock pessimista. |

---

## Resultados

### Execução final

| Cenário | Requisições | Throughput | p50 | p95 | p99 | máx | Erros |
|---|---|---|---|---|---|---|---|
| A: distribuídas | 61.034 | **3.052 req/s** | 14,4 ms | 31,4 ms | 47,3 ms | 236 ms | **0%** |
| B: hot wallet | 8.505 | **425 req/s** | 64,1 ms | 415 ms | 700 ms | 1.978 ms | **0%** |

| | A | B |
|---|---|---|
| Conflitos de concorrência detectados pelo banco | 0 | 0 |
| Outbox: pico de eventos pendentes | 42.262 | 124 |
| Outbox: pico de lag | 7,1 s | 0,13 s |
| Outbox: tempo para esvaziar após a carga | 5,6 s | 0,2 s |
| Consistência saldo × ledger | **200/200** | **1/1** |

### A primeira execução encontrou um gargalo na outbox

| Cenário A | 1ª execução | Depois da correção |
|---|---|---|
| Throughput | 1.398 req/s | 3.052 req/s (**2,2×**) |
| p50 / p95 / p99 | 30 / 78 / 113 ms | 14 / 31 / 47 ms |
| Outbox: pico de lag | 19,4 s | 7,1 s |
| Outbox: tempo para esvaziar | 36,6 s | 5,6 s (**6,5×**) |

**Diagnóstico:** a API gerava cerca de 2.500 eventos/s (cada transação gera 1 ou 2 eventos), mas os 3 relays juntos publicavam só ~900/s. Dois motivos no código do relay:

1. Depois de publicar um lote, ele marcava **cada evento com um `UPDATE` separado** (50 idas ao banco por lote).
2. Os lotes de 10 mensagens do SQS eram enviados **um de cada vez**.

**Correção:**
1. `releaseBatch`: o lote publicado é marcado num **único** `UPDATE ... WHERE id IN (...)`.
2. Envio em **8 faixas paralelas particionadas por `aggregateId`**: eventos do mesmo aggregate ficam sempre na mesma faixa e saem em ordem; aggregates diferentes saem em paralelo.
3. Lote de reivindicação de 50 → 200.

A latência da API também caiu porque os milhares de `UPDATE`s individuais da outbox competiam pelo banco com as próprias apostas.

---

## Análise

**Correção sob carga.** Nenhum erro, nenhum débito duplicado, e todas as wallets terminaram consistentes nos dois cenários. Os 6.000+ replays do cenário A devolveram exatamente a resposta original (200 com `idempotentReplay: true`).

**Por que "0 conflitos".** O contador mede corridas que o **banco** precisou resolver (unique violation em chave de idempotência ou em versão da wallet). Com o lock pessimista, as operações da mesma wallet esperam na fila do lock em vez de colidir; por isso o contador fica em zero mesmo no hot wallet. **O custo da contenção aparece na latência, não em conflitos:** é o p99 de 700 ms do cenário B.

**Hot wallet (cenário B).** 425 req/s numa única wallet significa ~2,3 ms por transação serializada: lock, decisão, 4 escritas e commit. Esse é o teto por wallet do desenho atual. A cauda (p99 de 700 ms, máximo de ~2 s) é a espera na fila do lock com 50 conexões disputando a mesma linha. Continua bem abaixo do `lock_timeout` de 5 s, então nenhuma requisição falhou. Para um jogador real, que faz poucas apostas por segundo, isso sobra. Para uma "wallet da casa", com milhares de operações por segundo, seria preciso particionar o saldo em sub-contas (ver ARCHITECTURE.md §13).

**Outbox.** No cenário A, a produção (~5.500 eventos/s: ~2.750 transações novas/s, cada uma gerando 2 eventos) ainda supera o ritmo do relay, então o backlog cresce durante a carga e zera em ~6 s depois dela. Com tráfego sustentado nesse nível, o próximo passo seria escalar os relays de forma independente das instâncias da API, ou aumentar as faixas paralelas. **Nenhum evento é perdido**: o atraso afeta só a pontualidade dos consumidores downstream, não a correção.

## Limitações do experimento

- Gerador de carga, aplicação, banco e LocalStack **dividem a mesma máquina** (10 núcleos). Os números servem para comparar cenários e versões, não como capacidade de produção.
- O **LocalStack** não reproduz a latência de rede nem os limites de throughput do SQS real (por exemplo, 300 mensagens/s por grupo FIFO sem *high throughput mode*).
- Execuções de 20 s: suficientes para os percentis, mas não exercitam efeitos de longo prazo (crescimento das tabelas, autovacuum, retenção de inbox/outbox).
- O cenário mede o caminho HTTP. O caminho SQS usa o mesmo caso de uso; o custo extra é a inbox (um `INSERT` a mais por mensagem).
