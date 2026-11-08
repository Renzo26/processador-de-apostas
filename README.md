# Processador Distribuído de Apostas

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de múltiplos provedores, via **HTTP** e **SQS**. Ele permanece correto com mensagens duplicadas, fora de ordem ou concorrentes, e com várias instâncias rodando ao mesmo tempo.

**Stack:** Bun 1.4 · TypeScript (strict) · NestJS 12 · PostgreSQL 17 · MikroORM 7 · AWS SQS (LocalStack) · Docker Compose

> Decisões de design, trade-offs e limitações: **[ARCHITECTURE.md](ARCHITECTURE.md)**
>
> Teste de carga (metodologia, resultados e análise): **[docs/LOAD_TEST.md](docs/LOAD_TEST.md)**. Resumo: 3.052 req/s com p99 de 47 ms em wallets distribuídas, 425 req/s numa única wallet disputada, zero erros e todas as wallets consistentes.

---

## Requisitos

- [Bun](https://bun.sh) ≥ 1.4
- Docker com Docker Compose v2 (no macOS, recomendo o [OrbStack](https://orbstack.dev))

Portas usadas no host: `55432` (PostgreSQL), `4566` (LocalStack) e `8080` (balanceador). Todas podem ser alteradas via `.env`; veja `.env.example`.

---

## Subindo o ambiente

### Opção A: tudo em containers (3 instâncias + balanceador)

```bash
docker compose --profile app up -d --build
curl localhost:8080/health/ready
# {"status":"ok","checks":{"database":"up","sqs":"up"}}
```

Isso sobe PostgreSQL, LocalStack, a criação das filas, as migrations, **3 instâncias da aplicação** (`app-1..3`) e um nginx em `:8080` distribuindo as requisições em round-robin. Cada instância também consome a fila SQS e roda os workers de outbox e de referências pendentes.

### Opção B: infraestrutura em containers, aplicação local (desenvolvimento)

```bash
bun install
cp .env.example .env
docker compose up -d                 # postgres + sqs + criação das filas
bun run migrate                      # aplica as migrations
bun run dev                          # http://localhost:3000
```

Para parar: `docker compose --profile app down`. Para apagar também os dados, acrescente `-v`.

---

## Comandos

| Comando | O que faz |
|---|---|
| `bun run dev` / `bun run start` | sobe a aplicação (com/sem watch) |
| `bun run migrate` | aplica as migrations pendentes |
| `bun run migrate:down` | reverte a última migration |
| `bun run migrate:status` | lista as migrations executadas e pendentes |
| `bun run typecheck` | checagem de tipos (`tsc --noEmit`) |
| `bun run test` | **suíte completa** (unitários + integração + e2e) |
| `bun run test:unit` | só domínio, sem infraestrutura |
| `bun run test:integration` | PostgreSQL e LocalStack reais |
| `bun run test:e2e` | sobe **3 processos reais** da aplicação |
| `bun run test:load` | teste de carga contra a stack de 3 instâncias (veja [docs/LOAD_TEST.md](docs/LOAD_TEST.md)) |
| `bun scripts/send-wager-message.ts <walletId> <playerId> <kind> <amount> [extId] [refExtId]` | publica uma mensagem na fila |

> Os testes de integração e e2e exigem `docker compose up -d` em execução. Eles usam um **banco exclusivo** (`wagering_test`, criado automaticamente no mesmo PostgreSQL) e **filas SQS exclusivas por teste**, então podem rodar mesmo com a aplicação no ar (`--profile app`) sem interferência. Os dados são isolados por IDs próprios, então não é preciso limpar o banco entre execuções (o ledger é append-only e nem pode ser truncado).

---

## Usando a API

### Swagger (navegador)

Com a aplicação no ar, abra **http://localhost:8080/docs** (opção A) ou **http://localhost:3000/docs** (opção B). Todos os endpoints estão documentados, com exemplos de cada resposta (201/200/202/400/409/422/503), e podem ser executados pelo botão **Try it out**. O documento OpenAPI fica em `/docs-json`.

Os schemas de entrada do Swagger são **gerados a partir dos mesmos schemas zod usados na validação**, então a documentação não tem como divergir do que a API aceita.

Roteiro rápido pelo Swagger:
1. `POST /wallets` → **Try it out** → **Execute**. Copie `id` e `playerId` da resposta. (O exemplo usa um `playerId` fixo: a partir da segunda vez, troque por um UUID novo, senão a resposta é 409 `WALLET_ALREADY_EXISTS`.)
2. `POST /wagering/transactions` → cole os valores em `walletId` e `playerId` do exemplo e preencha `Idempotency-Key` → **Execute** (201).
3. Clique **Execute** de novo, sem mudar nada: 200 com `idempotentReplay: true` e o mesmo saldo.
4. Mude `amount` e execute com a mesma key: 409.

### Linha de comando

Os exemplos usam `B=http://localhost:8080` (opção A) ou `B=http://localhost:3000` (opção B).

### 1. Criar wallet

```bash
curl -s -XPOST $B/wallets -H 'content-type: application/json' -d '{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}'
# 201 {"id":"<walletId>","playerId":"...","balance":{"amount":"1000.00","currency":"BRL"},"version":1}
```

### 2. Submeter transação

```bash
curl -s -XPOST $B/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<walletId>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
# 201 {"transactionId":"...","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
```

Se você repetir a mesma requisição, recebe `200` com `idempotentReplay: true` e **o mesmo saldo de antes**. Se usar a mesma key com outro valor, recebe `409 IDEMPOTENCY_KEY_REUSED`.

Para `REFUND`/`ROLLBACK`, inclua `"referenceExternalTransactionId": "<id da operação no provedor>"`. Se a referência ainda não chegou, a resposta é `202` com `status: "PENDING_REFERENCE"`, e a transação é aplicada automaticamente quando a referência chegar.

| Status | Significado |
|---|---|
| 201 / 200 | processada / replay |
| 202 | aceita, aguardando referência |
| 422 | rejeitada por regra de negócio (`failureCode` no corpo) |
| 400 | payload inválido |
| 409 | conflito de idempotência / wallet duplicada |
| 503 | falha transitória: reenvie com a **mesma** `Idempotency-Key` |

A taxonomia completa de `failureCode` está em [ARCHITECTURE.md §3.1](ARCHITECTURE.md#31-taxonomia-de-falhas-failurecode).

### 3. Consultas

```bash
curl $B/wallets/<walletId>
curl "$B/wallets/<walletId>/ledger?limit=50"             # devolve nextCursor (opaco)
curl "$B/wallets/<walletId>/ledger?cursor=<nextCursor>"
curl $B/wagering/transactions/<transactionId>
curl $B/providers/provider-a/wagering/transactions/transaction-123
```

### 4. Reconciliação

```bash
curl -s -XPOST $B/wallets/<walletId>/reconciliation
# {"walletId":"...","storedBalance":{...},"calculatedBalance":{...},"difference":{"amount":"0.00",...},"consistent":true,"checkedEntries":42}
```

### 5. Via SQS

```bash
bun scripts/send-wager-message.ts <walletId> <playerId> BET 10.00
```

O formato da mensagem segue a seção 10 do enunciado (`messageId`, `type: "WagerTransactionRequested"`, `occurredAt`, `data` com `idempotencyKey`). Mensagens inválidas vão para `wager-transactions-dlq.fifo`.

### 6. Operação

```bash
curl $B/health/live      # processo vivo
curl $B/health/ready     # PostgreSQL e SQS alcançáveis (503 se não)
curl $B/metrics          # métricas Prometheus
```

Os logs são JSON, uma linha por evento, com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`. Envie `X-Correlation-Id` para propagar o seu próprio id.

---

## Estrutura

```
src/
  domain/            Money, Wallet, WagerTransaction, ledger, inbox/outbox, eventos, regras (sem framework)
  application/       casos de uso + portas (UnitOfWork, repositórios, métricas, publisher)
  infrastructure/    PostgreSQL (MikroORM + migrations), SQS, Prometheus, logger JSON
  interfaces/        HTTP (Nest), consumer SQS, workers de fundo
  app.module.ts      composição (único lugar que conhece o Nest + implementações)
test/
  integration/       PostgreSQL e LocalStack reais
  e2e/               3 processos reais da aplicação
scripts/             migrations e envio de mensagens
infra/               criação das filas SQS, nginx
```

---

## Variáveis de ambiente principais

| Variável | Padrão | Descrição |
|---|---|---|
| `DATABASE_URL` | `postgresql://wagering:wagering@localhost:55432/wagering` | conexão PostgreSQL |
| `SQS_ENDPOINT` | `http://localhost:4566` | endpoint do LocalStack |
| `SQS_MAX_RECEIVE_COUNT` | `5` | tentativas antes da DLQ |
| `DB_LOCK_TIMEOUT_MS` | `5000` | espera máxima pelo lock da wallet |
| `REFERENCE_MAX_ATTEMPTS` | `10` | tentativas para referência fora de ordem |
| `OUTBOX_LEASE_MS` | `30000` | lease de publicação da outbox |
| `SQS_CONSUMER_ENABLED`, `OUTBOX_PUBLISHER_ENABLED`, `PENDING_REFERENCE_WORKER_ENABLED` | `true` | liga/desliga os processos de fundo |
| `LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error` |

A lista completa (validada na inicialização) está em [src/config.ts](src/config.ts).
