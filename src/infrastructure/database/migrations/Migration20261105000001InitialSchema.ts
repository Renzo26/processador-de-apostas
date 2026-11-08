import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As garantias de unicidade, imutabilidade e não-negatividade
 * vivem AQUI, não só no código: mesmo um bug de aplicação (ou um UPDATE manual)
 * não consegue duplicar débito, negativar saldo ou reescrever o ledger.
 */
export class Migration20261105000001InitialSchema extends Migration {
  override async up(): Promise<void> {
    // ------------------------------------------------------------------ wallets
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid           PRIMARY KEY,
        player_id   uuid           NOT NULL,
        currency    char(3)        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20, 2) NOT NULL CHECK (balance >= 0),
        version     integer        NOT NULL CHECK (version >= 1),
        created_at  timestamptz    NOT NULL,
        updated_at  timestamptz    NOT NULL,
        -- no máximo uma wallet por player + moeda
        CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency),
        -- alvo da FK composta do ledger (garante moeda do lançamento == moeda da wallet)
        CONSTRAINT wallets_id_currency_uq UNIQUE (id, currency)
      );
    `);

    // ------------------------------------------------------- wager_transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid           PRIMARY KEY,
        provider_id                       varchar(128)   NOT NULL,
        external_transaction_id           varchar(128)   NOT NULL,
        idempotency_key                   varchar(256)   NOT NULL,
        payload_hash                      char(64)       NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        -- sem FK: transações rejeitadas por WALLET_NOT_FOUND também são auditáveis
        wallet_id                         uuid           NOT NULL,
        player_id                         uuid           NOT NULL,
        round_id                          varchar(128)   NOT NULL,
        game_id                           varchar(128)   NOT NULL,
        kind                              varchar(16)    NOT NULL
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount                            numeric(20, 2) NOT NULL CHECK (amount >= 0),
        currency                          char(3)        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id varchar(128),
        reference_transaction_id          uuid           REFERENCES wager_transactions (id),
        status                            varchar(24)    NOT NULL
          CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code                      varchar(64),
        resulting_balance                 numeric(20, 2),
        reference_attempts                integer        NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
        next_reference_attempt_at         timestamptz,
        correlation_id                    varchar(128)   NOT NULL,
        created_at                        timestamptz    NOT NULL,
        processed_at                      timestamptz,

        -- idempotência: a key (header) é a fonte da verdade, por provider
        CONSTRAINT wager_tx_idempotency_uq UNIQUE (provider_id, idempotency_key),
        -- a mesma operação do provider existe uma única vez (e é a chave de resolução de referência)
        CONSTRAINT wager_tx_external_uq UNIQUE (provider_id, external_transaction_id),

        CONSTRAINT wager_tx_amount_positive_ck
          CHECK (kind = 'LOSS' OR amount > 0),
        CONSTRAINT wager_tx_reference_required_ck
          CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_terminal_has_processed_at_ck
          CHECK ((status IN ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at IS NOT NULL)),
        CONSTRAINT wager_tx_failure_code_ck
          CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT wager_tx_processed_has_balance_ck
          CHECK (status <> 'PROCESSED' OR resulting_balance IS NOT NULL),
        CONSTRAINT wager_tx_pending_reference_schedule_ck
          CHECK ((status = 'PENDING_REFERENCE') = (next_reference_attempt_at IS NOT NULL))
      );
    `);

    // Uma referência só pode ser revertida UMA vez (por REFUND ou ROLLBACK).
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_uq
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED';
    `);
    // Worker de referências pendentes: varre apenas as linhas elegíveis.
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_idx
        ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`CREATE INDEX wager_tx_wallet_idx ON wager_transactions (wallet_id, created_at);`);

    // Estados terminais são imutáveis; transações nunca são apagadas.
    this.addSql(`
      CREATE FUNCTION wager_tx_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transactions are append-only (DELETE forbidden)' USING ERRCODE = 'restrict_violation';
        END IF;
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'wager_transaction % is terminal (%) and cannot change', OLD.id, OLD.status
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.id <> OLD.id OR NEW.provider_id <> OLD.provider_id
           OR NEW.external_transaction_id <> OLD.external_transaction_id
           OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.payload_hash <> OLD.payload_hash
           OR NEW.wallet_id <> OLD.wallet_id OR NEW.kind <> OLD.kind
           OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency THEN
          RAISE EXCEPTION 'wager_transaction % identity fields are immutable', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER wager_tx_guard_trg
        BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_tx_guard();
    `);

    // ---------------------------------------------------- wallet_ledger_entries
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid           PRIMARY KEY,
        -- sequência monotônica: base do cursor estável de paginação
        seq             bigint         GENERATED ALWAYS AS IDENTITY UNIQUE,
        wallet_id       uuid           NOT NULL,
        transaction_id  uuid           NOT NULL REFERENCES wager_transactions (id),
        direction       varchar(6)     NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount          numeric(20, 2) NOT NULL CHECK (amount > 0),
        currency        char(3)        NOT NULL,
        balance_before  numeric(20, 2) NOT NULL CHECK (balance_before >= 0),
        balance_after   numeric(20, 2) NOT NULL CHECK (balance_after >= 0),
        -- versão da wallet APÓS o lançamento
        wallet_version  integer        NOT NULL CHECK (wallet_version >= 1),
        created_at      timestamptz    NOT NULL,

        CONSTRAINT ledger_wallet_currency_fk FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        -- uma transação financeira produz no máximo um lançamento por wallet
        CONSTRAINT ledger_wallet_transaction_uq UNIQUE (wallet_id, transaction_id),
        -- dois lançamentos nunca podem partir da mesma versão: barreira final contra lost update
        CONSTRAINT ledger_wallet_version_uq UNIQUE (wallet_id, wallet_version),
        -- aritmética do lançamento
        CONSTRAINT ledger_balanced_ck CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        )
      );
    `);
    this.addSql(`CREATE INDEX ledger_wallet_seq_idx ON wallet_ledger_entries (wallet_id, seq);`);

    // Ledger append-only: UPDATE, DELETE e TRUNCATE são bloqueados no banco.
    this.addSql(`
      CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% forbidden)', TG_OP
          USING ERRCODE = 'restrict_violation';
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER ledger_append_only_trg
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
    `);
    this.addSql(`
      CREATE TRIGGER ledger_no_truncate_trg
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
    `);

    // Saldo materializado == último lançamento do ledger, verificado no COMMIT
    // (constraint trigger adiada). Torna impossível alterar o saldo sem o
    // lançamento correspondente — inclusive via SQL manual.
    this.addSql(`
      CREATE FUNCTION wallet_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        last_balance numeric(20, 2);
        last_version integer;
      BEGIN
        SELECT balance_after, wallet_version INTO last_balance, last_version
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.id
         ORDER BY wallet_version DESC
         LIMIT 1;

        IF NOT FOUND THEN
          last_balance := 0;
          last_version := 1;
        END IF;

        IF NEW.balance <> last_balance OR NEW.version <> last_version THEN
          RAISE EXCEPTION 'wallet % out of sync with ledger: balance %/% version %/%',
            NEW.id, NEW.balance, last_balance, NEW.version, last_version
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_matches_ledger_trg
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_matches_ledger();
    `);
    this.addSql(`
      CREATE FUNCTION wallet_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallets cannot be deleted' USING ERRCODE = 'restrict_violation';
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER wallet_no_delete_trg
        BEFORE DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wallet_no_delete();
    `);

    // ----------------------------------------------------------- inbox / outbox
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name varchar(128) NOT NULL,
        message_id    varchar(256) NOT NULL,
        payload_hash  char(64)     NOT NULL,
        received_at   timestamptz  NOT NULL,
        processed_at  timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid         PRIMARY KEY,
        seq             bigint       GENERATED ALWAYS AS IDENTITY UNIQUE,
        aggregate_id    uuid         NOT NULL,
        event_type      varchar(128) NOT NULL,
        payload         jsonb        NOT NULL,
        occurred_at     timestamptz  NOT NULL,
        attempts        integer      NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz,
        -- lease: impede que dois publishers peguem a mesma mensagem enquanto ela está em voo
        locked_until    timestamptz,
        locked_by       varchar(128),
        published_at    timestamptz,
        last_error      varchar(500)
      );
    `);
    this.addSql(`
      CREATE INDEX outbox_pending_idx
        ON outbox_messages (next_attempt_at, seq)
        WHERE published_at IS NULL;
    `);
    // O conteúdo do evento é imutável; só o controle de entrega muda.
    this.addSql(`
      CREATE FUNCTION outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.payload IS DISTINCT FROM OLD.payload OR NEW.event_type <> OLD.event_type
           OR NEW.aggregate_id <> OLD.aggregate_id OR NEW.occurred_at <> OLD.occurred_at THEN
          RAISE EXCEPTION 'outbox message % content is immutable', OLD.id USING ERRCODE = 'restrict_violation';
        END IF;
        IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
          RAISE EXCEPTION 'outbox message % already published', OLD.id USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER outbox_guard_trg
        BEFORE UPDATE ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION outbox_guard();
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS outbox_messages;');
    this.addSql('DROP FUNCTION IF EXISTS outbox_guard();');
    this.addSql('DROP TABLE IF EXISTS inbox_messages;');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;');
    this.addSql('DROP FUNCTION IF EXISTS ledger_append_only();');
    this.addSql('DROP TABLE IF EXISTS wager_transactions;');
    this.addSql('DROP FUNCTION IF EXISTS wager_tx_guard();');
    this.addSql('DROP TABLE IF EXISTS wallets;');
    this.addSql('DROP FUNCTION IF EXISTS wallet_matches_ledger();');
    this.addSql('DROP FUNCTION IF EXISTS wallet_no_delete();');
  }
}
