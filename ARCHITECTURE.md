# Arquitetura — Processador Distribuído de Apostas

Este documento registra **as decisões, os trade-offs e as limitações** da solução. Comandos e setup estão no [README](README.md).

---

## 1. Visão geral

```
                 ┌──────────────┐        ┌────────────────────────────┐
  Provedor ─────▶│ HTTP (Nest)  │──┐     │  wager-transactions.fifo   │◀──── Provedor
  (REST)         └──────────────┘  │     └─────────────┬──────────────┘
                                   │                   │ consumer (inbox)
                                   ▼                   ▼
                        ┌─────────────────────────────────────────┐
                        │   ProcessWagerTransaction (caso de uso  │
                        │   ÚNICO para HTTP, SQS e reprocesso)    │
                        └──────────────────┬──────────────────────┘
                                           │ 1 transação SQL
     ┌──────────────┬──────────────┬───────┴──────┬──────────────┬──────────────┐
     ▼              ▼              ▼              ▼              ▼              ▼
  inbox     SELECT wallet     wager_tx      UPDATE wallet    ledger entry    outbox
  (dedup)   FOR UPDATE        (idempot.)    (versão)         (append-only)   (eventos)
                                                                                │
                         ┌─────────────────────────────┐                        │
                         │ OutboxRelay (lease +        │◀───────────────────────┘
                         │ SKIP LOCKED, N instâncias)  │──────▶ wallet-events.fifo
                         └─────────────────────────────┘
                         ┌─────────────────────────────┐
                         │ PendingReferenceWorker      │──▶ reprocessa PENDING_REFERENCE
                         └─────────────────────────────┘
```

Todas as instâncias são idênticas e executam API, consumer, relay e worker. **Não há líder nem estado em memória que afete a correção**: as garantias estão no PostgreSQL.

### Camadas (hexagonal)

| Camada | Pasta | Conhece |
|---|---|---|
| Domínio | `src/domain` | nada externo (sem Nest, sem ORM). `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, eventos, `WagerSettlement` |
| Aplicação | `src/application` | domínio + **portas** (`UnitOfWork`, repositórios, `Metrics`, `Clock`, `EventPublisher`, `OutboxStore`) |
| Infraestrutura | `src/infrastructure` | implementações das portas (PostgreSQL via MikroORM, SQS, Prometheus, logger) |
| Interfaces | `src/interfaces` | adaptadores de entrada: HTTP (Nest), consumer SQS, workers |

A composição é feita só em `src/app.module.ts`, por factories. Domínio e aplicação não têm decorators.

---

## 2. Modelo de domínio

Todas as entidades seguem a regra 6.0: **construtor privado** e as factories `create`/`open`/`enqueue`/`receive` (que validam) e `rehydrate` (que só reconstrói o estado persistido, sem revalidar transições).

### 2.1 `Money`
- Usa `decimal.js` numa instância isolada (`Decimal.clone`, precisão 40). **Nenhum `number` toca em dinheiro.**
- Entrada aceita apenas `^(0|[1-9]\d{0,17})(\.\d{1,2})?$`. Isso rejeita `NaN`, `Infinity`, notação científica, sinal, zeros à esquerda, vírgula, espaços, string vazia, mais de 2 casas e valores acima de `NUMERIC(20,2)`.
- **Não existe arredondamento.** Mais de 2 casas é erro de entrada, e soma/subtração com escala 2 é exata. Arredondar dinheiro em silêncio esconde bugs.
- A serialização tem sempre escala 2 (`"25.00"`), e `-0` é normalizado para `"0.00"`.
- Moedas diferentes geram `CurrencyMismatchError`. O modelo é multi-moeda; os testes usam BRL e USD.

**Mapeamento na persistência:** `NUMERIC(20,2)` mais `char(3)` para a moeda. O driver `pg` devolve `NUMERIC` como **string**, que é reidratada com `Money.rehydrate`. A soma da reconciliação é feita **no banco**, em `NUMERIC`, nunca em JS.

### 2.2 `Wallet`
- O saldo só muda por `debit`/`credit`/`move`, e esses métodos **devolvem o `WalletLedgerEntry`**. Não existe caminho que altere o saldo sem gerar lançamento.
- `version` começa em 1 e incrementa a cada mudança de saldo. Ela é gravada no lançamento (`wallet_version`) e protegida por `UNIQUE (wallet_id, wallet_version)`.
- O crédito de abertura gera lançamento (transação interna `OPENING`), mas a wallet **nasce** na versão 1 com o saldo inicial, conforme o exemplo do enunciado.

### 2.3 `WagerTransaction`: máquina de estados

```
PENDING ──┬──▶ PROCESSED   (terminal)
          ├──▶ REJECTED    (terminal, failureCode)
          ├──▶ FAILED      (terminal, failureCode)
          └──▶ PENDING_REFERENCE ──┬──▶ PENDING_REFERENCE  (nova tentativa agendada)
                                   └──▶ PROCESSED | REJECTED | FAILED
```

- Transição a partir de estado terminal lança `InvalidTransactionStateError`. É **erro de programação**, por isso não estende `DomainError`.
- A transação guarda `resultingBalance` (o saldo observado no momento da decisão), que é o que o replay devolve (regra 7).
- `OPENING` só nasce por `WagerTransaction.opening()`. Pela API ou pela fila, ele é recusado já na validação.

### 2.4 `WalletLedgerEntry`
- Todos os campos são `readonly` e a instância é `Object.freeze`. Não há métodos de transição.
- `create` calcula `balanceAfter` e rejeita valor ≤ 0 ou saldo resultante negativo. `isBalanced()` permite auditar lançamentos reidratados.

### 2.5 `WagerSettlement` (serviço de domínio)
É uma função pura que decide e aplica o efeito de uma transação sobre a wallet. A ordem de validação é: wallet existe → player confere → moeda confere → referência (existência, contexto, tipo, status, já revertida, valor) → saldo. Todas as regras de BET/WIN/LOSS/REFUND/ROLLBACK são testadas sem banco (`wager-settlement.spec.ts`).

---

## 3. Regras de negócio e interpretações adotadas

| Operação | Saldo | Ledger | Referência aceita |
|---|---|---|---|
| BET | débito | 1 DEBIT | — |
| WIN | crédito | 1 CREDIT | opcional: BET |
| LOSS | nenhum | nenhum | opcional: BET |
| REFUND | crédito | 1 CREDIT | **obrigatória**: BET |
| ROLLBACK | inverso da referência | 1 entrada invertida | **obrigatória**: BET, WIN ou REFUND |

**Interpretações (o que o enunciado deixou em aberto):**

1. **Uma referência só pode ser revertida UMA vez, por qualquer tipo de reversão.** O enunciado diz "não pode ser revertida duas vezes *pelo mesmo tipo*". Mas permitir REFUND **e** ROLLBACK da mesma BET creditaria o valor duas vezes, violando o invariante global "não duplicar créditos". Adotei a leitura estrita, garantida pelo índice único parcial `wager_tx_single_reversal_uq`. Reverter um REFUND com ROLLBACK continua permitido, porque é outra referência.
2. **Valor zero só é aceito em LOSS.** BET/WIN/REFUND/ROLLBACK com zero são payload inválido (400). Um lançamento de zero quebraria "toda alteração de saldo tem lançamento e vice-versa". A regra é reforçada pela constraint `wager_tx_amount_positive_ck`.
3. **Referência ainda não terminal** (a BET referenciada está `PENDING`/`PENDING_REFERENCE`) é tratada como **ausente**: a transação aguarda.
4. **Referência terminal mas não `PROCESSED`** (ex.: BET rejeitada por saldo) gera `REFERENCE_NOT_PROCESSED`, porque não há o que reverter.
5. **Mesmo `externalTransactionId` com outra idempotency key** é tratado como conflito (409), igual ao conflito de key. O par `(providerId, externalTransactionId)` identifica a operação no provedor.
6. **`playerId` diferente do dono da wallet** gera `WALLET_PLAYER_MISMATCH`. Uma wallet inexistente gera `WALLET_NOT_FOUND`, e a transação **é persistida como REJECTED** (auditável). Por isso não há FK de `wager_transactions.wallet_id` para `wallets`.

### 3.1 Taxonomia de falhas (`failureCode`)

Cada código indica ao provedor o que fazer: **FINAL** (não reenviar), **FIX_PAYLOAD** (corrigir e reenviar com **nova** key) ou **RETRY** (reenviar com a **mesma** key).

| Código | Ação | Quando |
|---|---|---|
| `INSUFFICIENT_FUNDS` | FINAL | BET sem saldo |
| `REVERSAL_INSUFFICIENT_FUNDS` | FINAL | ROLLBACK de crédito (WIN/REFUND) que negativaria o saldo. **Distinto** de aposta sem saldo: em operação, indica que o jogador já gastou o prêmio e exige tratamento manual |
| `WALLET_NOT_FOUND` / `WALLET_PLAYER_MISMATCH` / `CURRENCY_MISMATCH` | FIX_PAYLOAD | vínculo inválido com a wallet |
| `REFERENCE_NOT_FOUND` | FINAL | referência não chegou dentro da janela de espera |
| `REFERENCE_MISMATCH` | FINAL | referência de outro provider/player/wallet/rodada/moeda |
| `REFERENCE_KIND_NOT_ALLOWED` | FINAL | ex.: REFUND de WIN, ROLLBACK de LOSS |
| `REFERENCE_NOT_PROCESSED` | FINAL | referência terminou REJECTED/FAILED |
| `REFERENCE_ALREADY_REVERSED` | FINAL | segunda reversão |
| `REFERENCE_AMOUNT_MISMATCH` | FINAL | reversão parcial (fora de escopo) |
| `PROCESSING_FAILED` | RETRY | reservado para FAILED (ver limitações) |

A tabela vive em código (`FAILURE_ACTION`, em `failure-code.ts`).

### 3.2 Referências fora de ordem (7.1)

- Quando a referência está ausente, a transação vira `PENDING_REFERENCE`, com `next_reference_attempt_at` calculado por backoff exponencial, e o evento `WagerTransactionPendingReference` é publicado.
- **Política padrão:** 10 tentativas, atraso de `1s · 2^n` com teto de 5 min por espera, o que dá **uma janela de ~13,5 min**. Provedores costumam entregar a operação referenciada em segundos. A janela cobre indisponibilidades curtas do broker ou do provedor sem deixar transações penduradas por tempo indeterminado. Tudo é configurável (`REFERENCE_*`).
- Ao esgotar as tentativas: `REJECTED` + `REFERENCE_NOT_FOUND` + evento `WagerTransactionRejected`.
- **Otimização:** quando uma transação é processada, as dependentes que esperavam por ela (`wakeDependents`) são antecipadas para "agora". Assim, o ROLLBACK é aplicado logo após a BET chegar, sem esperar o próximo backoff.
- O worker (`PendingReferenceWorker`) é seguro com N instâncias: ele trava a wallet (mesma ordem de lock do fluxo principal) e depois a transação com `FOR UPDATE SKIP LOCKED`, e revalida o status sob lock.

---

## 4. Concorrência

**Unidade de concorrência: a wallet.** A estratégia combina três camadas:

1. **Lock pessimista por linha** (`SELECT ... FROM wallets WHERE id = ? FOR UPDATE`) **antes** de qualquer leitura de idempotência, saldo ou referência. Duas apostas na mesma wallet serializam; wallets diferentes nunca se bloqueiam. **Não existe lock global.**
2. **UPDATE condicionado à versão** (`WHERE id = ? AND version = ?`), como defesa em profundidade. Se o lock falhar por qualquer motivo, o UPDATE não afeta linha e a operação é abortada.
3. **Constraints do banco como árbitro final** (seção 5): `UNIQUE (wallet_id, wallet_version)` impede que dois lançamentos partam da mesma versão; `CHECK (balance >= 0)` e a constraint trigger adiada impedem saldo negativo e saldo divergente do ledger.

**Por que pessimista, e não otimista com retry?** Em *hot wallets* (muitas apostas simultâneas no mesmo jogador), o modelo otimista gera retries em cascata e latência imprevisível. O lock de linha serializa de forma justa na fila do PostgreSQL, com custo baixo, porque a transação é curta: poucos statements, sem I/O externo dentro dela. Para limitar a espera, `SET LOCAL lock_timeout = 5s`. O timeout vira erro **transitório** (503 / retry no SQS).

**Isolamento:** `READ COMMITTED`. Toda decisão financeira ocorre sob o lock da linha da wallet, e cada statement enxerga o que foi commitado antes. Isso é suficiente: `SERIALIZABLE` acrescentaria abortos sem acrescentar garantia.

**Sem deadlock:** cada transação trava no máximo **uma** wallet, e sempre na ordem wallet → transação (inclusive no worker de referências).

**Corridas de idempotência sem wallet** (ex.: 50 cópias da mesma requisição para uma wallet inexistente) são resolvidas pela `UNIQUE (provider_id, idempotency_key)`. Quem perde a corrida recebe `ConcurrencyConflictError`, e o caso de uso **reexecuta** (até 3 vezes): na nova tentativa, o vencedor já está commitado e o fluxo cai no replay.

**Cenário obrigatório (100.00, duas apostas de 80.00):** coberto por teste unitário, de integração (`concurrency.spec.ts`) e e2e com 3 processos (60 apostas sobre 300.00 → exatamente 30 aceitas).

---

## 5. Schema: garantias no banco

Migration: `src/infrastructure/database/migrations/Migration20261105000001InitialSchema.ts`. É reversível (`down`), com teste que roda up → down → up num banco descartável.

| Garantia | Mecanismo |
|---|---|
| Saldo nunca negativo | `CHECK (balance >= 0)` em `wallets`; `CHECK (balance_after >= 0)` no ledger |
| Uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| Idempotência persistente | `UNIQUE (provider_id, idempotency_key)` |
| Operação única por provedor | `UNIQUE (provider_id, external_transaction_id)` |
| Reversão única | índice único parcial em `reference_transaction_id` `WHERE kind IN (REFUND, ROLLBACK) AND status = 'PROCESSED'` |
| No máximo 1 lançamento por transação/wallet | `UNIQUE (wallet_id, transaction_id)` |
| Sem lost update | `UNIQUE (wallet_id, wallet_version)` |
| Aritmética do lançamento | `CHECK` direção/before/amount/after |
| Moeda do lançamento == moeda da wallet | FK composta `(wallet_id, currency) → wallets(id, currency)` |
| **Ledger imutável** | triggers bloqueiam `UPDATE`, `DELETE` e `TRUNCATE` |
| **Saldo == último lançamento** | `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`: no COMMIT, `wallets.balance/version` precisam bater com o último `balance_after/wallet_version`. Torna impossível alterar o saldo sem lançamento, **inclusive por SQL manual** |
| Transação terminal imutável | trigger rejeita UPDATE quando o status atual é terminal, e campos de identidade nunca mudam |
| Coerência de estado | `CHECK`s: terminal ⇔ `processed_at`; REJECTED/FAILED ⇔ `failure_code`; PROCESSED ⇒ `resulting_balance`; REFUND/ROLLBACK ⇒ referência; PENDING_REFERENCE ⇔ agendamento |
| Inbox | `PRIMARY KEY (consumer_name, message_id)` |
| Conteúdo do evento imutável | trigger na outbox só permite mudar campos de entrega |

O teste `schema-constraints.spec.ts` tenta violar cada uma dessas garantias por **SQL direto**, contornando a aplicação.

---

## 6. Idempotência

Há três camadas, todas persistentes (nenhuma em memória):

| Camada | Chave | Onde |
|---|---|---|
| HTTP / domínio | `(providerId, Idempotency-Key)` | `wager_transactions` |
| Operação do provedor | `(providerId, externalTransactionId)` | `wager_transactions` |
| Mensageria | `(consumerName, messageId)` | `inbox_messages`, na **mesma transação** do efeito |

- **`payloadHash`** = SHA-256 (hex) do **JSON canônico** do subconjunto de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`, `referenceExternalTransactionId`. Chaves ordenadas recursivamente, `undefined` omitido, `money.amount` normalizado para escala 2 (`"25"` ≡ `"25.00"`). O header `Idempotency-Key`, `messageId`, `occurredAt` e os demais metadados de transporte **não** entram.
- **Requisição idêntica:** devolve a mesma resposta com `idempotentReplay: true`, incluindo o **saldo observado na época**, não o atual.
- **Mesma key, payload diferente:** `409 IDEMPOTENCY_KEY_REUSED`. Não é replay.
- O `Idempotency-Key` é obrigatório e é a fonte da verdade. O formato recomendado é `{providerId}:{externalTransactionId}`.
- O SQS FIFO (`MessageDeduplicationId`) é tratado como **otimização**, nunca como garantia.

---

## 7. API HTTP: mapeamento de status

O mapeamento é único (`interfaces/http/error-mapping.ts`) e vale para **todos** os endpoints. Erros seguem o envelope `{ "error": { code, message, retryable, details? } }`.

| Situação | Status | Reenviar? |
|---|---|---|
| Transação aplicada (1ª vez) | **201** | — |
| Replay de transação aplicada | **200** (`idempotentReplay: true`) | — |
| Aceita, aguardando referência | **202** | não; consultar depois |
| Rejeição por regra de negócio | **422** + `failureCode` no corpo | não |
| Payload inválido / header ausente | **400** `VALIDATION_ERROR` | só depois de corrigir |
| Conflito de idempotência | **409** `IDEMPOTENCY_KEY_REUSED` / `EXTERNAL_TRANSACTION_ID_REUSED` | não |
| Wallet duplicada | **409** `WALLET_ALREADY_EXISTS` | não |
| Recurso inexistente | **404** `*_NOT_FOUND` | não |
| Falha transitória (banco, lock timeout) | **503** `TRANSIENT_FAILURE` + `Retry-After` | **sim, com a mesma key** |
| Inesperado | **500** `INTERNAL_ERROR` | sim |

Por que **422** para rejeição: o pedido é válido e foi **decidido e persistido** (e é replayable); o que falhou foi a regra de negócio. Assim, rejeição fica distinta de payload inválido (400) e de falha de infraestrutura (5xx).

O ledger usa um **cursor opaco** (`base64url("v1:<seq>")`) sobre uma `seq` monotônica (`GENERATED ALWAYS AS IDENTITY`). Ele é estável sob inserções concorrentes: novas entradas sempre têm `seq` maior, e nada é pulado nem repetido.

---

## 8. Mensageria

### 8.1 Consumer SQS (`wager-transactions.fifo`)
- Reutiliza **o mesmo** `ProcessWagerTransaction` do HTTP, passando `inbox: { consumerName, messageId }`.
- A inbox é gravada com `INSERT ... ON CONFLICT DO NOTHING` **dentro** da transação. Se uma cópia concorrente estiver inserindo a mesma chave, o PostgreSQL bloqueia até ela terminar. Redelivery → replay → ack.
- O **ack (`DeleteMessage`) acontece somente após o commit.**
- `MessageGroupId = walletId`: o FIFO entrega em ordem por wallet. Isso é otimização; o lock no banco é a garantia.

**Classificação de erros:**

| Tipo | Exemplos | Ação |
|---|---|---|
| Negócio (terminal) | rejeição, `IdempotencyConflictError` | ack |
| Transitório | banco fora, lock timeout, unique race esgotada | `ChangeMessageVisibility` com backoff `2^receiveCount` s (teto 60 s) |
| Permanente | JSON inválido, schema inválido, `OPENING` pela fila | DLQ **explícita** (preservando corpo + motivo) e ack |
| Tentativas esgotadas | transitório com `receiveCount ≥ SQS_MAX_RECEIVE_COUNT` | DLQ explícita (`MAX_ATTEMPTS_EXCEEDED`) |

A redrive policy da fila (`maxReceiveCount`) é a rede de segurança caso o processo morra antes de mover a mensagem.

**SIGTERM:** o handler chama `app.close()`, que executa `beforeApplicationShutdown`. O consumer para o long-poll (com `AbortController`), **conclui** as mensagens em andamento e **devolve a visibilidade (0)** das que ainda não começaram. Os workers terminam o ciclo corrente. Só então o pool do banco é fechado (`onApplicationShutdown`). Há um timeout de segurança de 25 s, e o `stop_grace_period` do compose é 30 s.

### 8.2 Transactional Outbox
- Os eventos são gravados na **mesma transação SQL** da mudança de estado. Publicar antes do commit é impossível por construção.
- O relay **reivindica** mensagens com lease:
  ```sql
  UPDATE outbox_messages SET locked_until = now + lease, locked_by = :instance
   WHERE id IN (SELECT id ... WHERE published_at IS NULL AND next_attempt_at <= now
                  AND (locked_until IS NULL OR locked_until < now)
                ORDER BY seq LIMIT :n FOR UPDATE SKIP LOCKED)
  RETURNING *
  ```
  A publicação acontece **fora** de transação (sem segurar locks durante I/O de rede). Em seguida, `published_at` é marcado. Se a publicação falha, `attempts++` e o próximo horário segue backoff exponencial (teto de 5 min).
- **Cenário do enunciado:** commit → processo morre antes de publicar → o lease expira → outra instância reivindica e publica. Isso é testado.
- **Duplicatas são seguras:** o id da mensagem é o `eventId`. No SQS FIFO ele vira `MessageDeduplicationId` (o broker descarta repetições na janela de 5 min), e o consumidor downstream deve deduplicar por `eventId`. `WalletBalanceChanged` carrega `walletVersion` para ordenação e deduplicação no consumidor.
- Eventos são publicados em `wallet-events.fifo` com `MessageGroupId = aggregateId`.

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | qualquer transação aplicada, inclusive LOSS |
| `WagerTransactionRejected` | rejeição de negócio (inclusive `REFERENCE_NOT_FOUND`) |
| `WalletBalanceChanged` | somente quando o saldo muda (inclui o crédito de abertura) |
| `WagerTransactionPendingReference` | a cada vez que a transação entra/permanece aguardando referência |

O envelope é a classe abstrata `IntegrationEvent<T>` com uma subclasse por evento; `eventType` e `version` ficam **no tipo**. `data` carrega `MoneyProps` (string decimal), nunca `Money`.

---

## 9. Por que MikroORM, e como ele é usado

O MikroORM (opção preferencial) é usado para: **gerenciar a transação** (`em.transactional()` com nível de isolamento explícito), **pool de conexões**, **tradução de exceções** do driver e **migrations versionadas e reversíveis** (`@mikro-orm/migrations`, com lista explícita de migrations, sem depender de glob em disco).

Os repositórios executam **SQL explícito** (`em.execute`) **dentro** do contexto transacional do EntityManager, em vez de mapear as entidades de domínio como entidades do ORM. A razão:

- **Os caminhos críticos são statements específicos de concorrência:** `SELECT ... FOR UPDATE`, `INSERT ... ON CONFLICT DO NOTHING`, `UPDATE ... WHERE version = ?`, `FOR UPDATE SKIP LOCKED`, `UPDATE ... RETURNING` com lease. Ter esses comandos visíveis no código é parte do que está sendo avaliado. Escondê-los atrás do change-set do Unit of Work tornaria a ordem e a forma dos statements implícitas.
- **O domínio fica livre do ORM:** construtores privados, campos `_privados`, `Money` como value object, `rehydrate` sem revalidação. Mapeá-los via `EntitySchema` exigiria abrir mão de parte do encapsulamento ou escrever custom types e hidratadores, sem ganho de garantia.
- **O Identity Map não traz benefício aqui:** cada comando carrega um único aggregate **já travado** e o descarta ao final. Um `em.fork()` por unidade de trabalho evita qualquer vazamento de estado entre requisições.

O trade-off é mais SQL escrito à mão (com testes de integração cobrindo cada repositório), em troca de controle explícito sobre locks e conflitos.

---

## 10. Observabilidade

- **Logs estruturados** (uma linha JSON por evento) via `JsonLogger`, que substitui o logger do Nest. Um `AsyncLocalStorage` propaga `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` para todos os logs da requisição ou mensagem. O `X-Correlation-Id` de entrada é aceito (validado) ou gerado, e devolvido na resposta.
- **Sem dados sensíveis:** os logs nunca incluem payload, valores ou saldos. Chaves como `money`, `balance`, `payload`, `authorization` e `token` são redigidas por padrão.
- **Métricas Prometheus** em `GET /metrics`:

| Métrica | Cobre |
|---|---|
| `wager_transactions_total{kind,status,source}` | transações por status |
| `wager_duplicates_detected_total{source,layer}` | duplicatas (idempotency key / inbox) |
| `wager_retries_total{operation,reason}` | retries (corridas, SQS, outbox, referências) |
| `wager_lock_conflicts_total{operation}` | conflitos de concorrência |
| `wager_processing_duration_seconds` (histograma) | latência de processamento |
| `outbox_pending_messages`, `outbox_lag_seconds` | outbox lag |
| `outbox_published_total`, `outbox_publish_failures_total` | publicação |
| `sqs_messages_to_dlq_total{reason}`, `sqs_dlq_approximate_messages` | DLQ |
| `wallet_reconciliation_mismatches_total` | divergências de reconciliação |

- **Health:** `GET /health/live` (só o processo; não consulta dependências, para evitar restart em cascata) e `GET /health/ready` (PostgreSQL e SQS, com timeout de 2 s; responde 503 quando indisponível). Os dois ficam abertos.
- **Reconciliação** (`POST /wallets/:id/reconciliation`): sob lock da wallet, compara o saldo materializado com a soma do ledger (em `NUMERIC`). Divergências **não** são corrigidas: geram log `warn`, incrementam a métrica e aparecem na resposta (`consistent: false`).

---

## 11. Autenticação

> Seção 2 do enunciado: autenticação não pontua e não deve competir com o núcleo.

**Situação atual:** o ponto de extensão está implementado, e o IdP ainda não está integrado.

- `ProviderIdentityPort` (porta) + `ProviderAuthGuard`, aplicado aos endpoints de negócio. Health e metrics ficam abertos.
- Sem IdP configurado, a porta é `undefined` e o guard é **no-op**.
- O guard já aplica a regra de domínio que mais importa: **o provedor autenticado só opera em nome de si mesmo** (`assertProviderMatches`: `providerId` do token ≠ `providerId` do payload → 403). Endpoints de backoffice (criar wallet, reconciliação) exigem um papel próprio (`assertBackoffice`).

**Desenho previsto (Keycloak, OIDC):**
- Cada provedor de jogos é um **client confidencial** com *client credentials grant* (máquina-a-máquina, sem usuários nem senhas na aplicação).
- O token JWT carrega `provider_id` (mapper de claim) e papéis (`wagering:write`, `backoffice`).
- A implementação de `ProviderIdentityPort` valida a assinatura via **JWKS** (com cache e rotação de chaves), `iss`, `aud` e `exp`.
- Mensagens da fila são canal interno confiável, mas o `providerId` da mensagem passa pelas **mesmas validações de domínio**.

---

## 12. Testes

| Suíte | O que prova | Infra |
|---|---|---|
| `src/**/*.spec.ts` | `Money`, invariantes de `Wallet`, máquina de estados, regras de BET/WIN/LOSS/REFUND/ROLLBACK, conflito de moeda, payload divergente, outbox/inbox, hash canônico | nenhuma |
| `test/integration/schema-constraints` | migrations reversíveis e cada constraint/trigger, atacada por SQL direto | PostgreSQL |
| `test/integration/concurrency` | 100−80−80 simultâneo, mesma aposta 50× em paralelo, hot wallet, wallets em paralelo | PostgreSQL |
| `test/integration/wagering-flows` | replay com saldo original, conflitos, fora de ordem, `REFERENCE_NOT_FOUND`, reversões concorrentes, **atomicidade** (falha no último passo desfaz tudo), cursor | PostgreSQL |
| `test/integration/outbox` | **publishers concorrentes** (cada evento exatamente uma vez), crash antes de publicar + lease, backoff, republicação real no SQS FIFO | PostgreSQL + LocalStack |
| `test/integration/sqs-consumer` | inbox/redelivery, **crash depois do commit e antes do ack**, retry transitório, DLQ por limite, DLQ por payload inválido, rejeição terminal, stop gracioso | PostgreSQL + LocalStack |
| `test/e2e/multi-instance` | **3 processos reais**: hot wallet via HTTP, 50× em paralelo, SQS com duplicatas, outbox drenada, **SIGKILL depois do commit e antes do ack** (fault injection), SIGTERM gracioso, **reinício sob carga com consistência final** | PostgreSQL + LocalStack + 3 processos |

**Invariante verificado em todos os testes de integração:** `wallet.balance == saldo reconstruído pelo ledger` (via reconciliação). PostgreSQL e SQS **nunca** são substituídos por mocks. Os únicos dublês são falhas injetadas (cliente SQS que "morre" no ack, publisher que falha) para exercitar caminhos de erro de forma determinística.

---

## 13. Limitações e trabalho futuro

- **Estado `FAILED` não é produzido pelos fluxos atuais.** Erros permanentes de infraestrutura chegam à DLQ com motivo e corpo preservados (é ela o registro auditável). Persistir `FAILED` exigiria gravar justamente quando o banco é a dependência que falha. Ficou reservado (`PROCESSING_FAILED`) para uma ferramenta de reprocessamento da DLQ.
- **Ordem de eventos entre publishers concorrentes** não é estritamente garantida por aggregate. Com dois relays e leases diferentes, um evento mais novo pode sair antes. O consumidor deve usar `walletVersion` (e `eventId` para deduplicar). Uma alternativa seria particionar o relay por `aggregate_id`.
- **Retenção** de `inbox_messages` e `outbox_messages` publicadas não está implementada. Em produção, usar particionamento por data ou um job de expurgo, mantendo a janela de deduplicação maior que o tempo máximo de redelivery.
- **Hot wallet extrema:** o lock pessimista serializa as apostas de uma mesma wallet. O throughput por wallet é limitado pela latência de uma transação curta. Isso é aceitável para um jogador, mas não para uma "wallet da casa"; esse caso exigiria sub-contas ou saldo particionado.
- **A contagem de duplicatas** soma a camada `inbox` e a camada `idempotency_key` quando uma mesma redelivery passa pelas duas.
- **Métricas são por instância:** a agregação fica a cargo do Prometheus (scrape das N instâncias).
