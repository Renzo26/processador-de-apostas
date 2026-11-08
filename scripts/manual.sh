# Atalhos para testes manuais. Uso:
#   source scripts/manual.sh          (no zsh ou bash)
#   nova_wallet 100.00                → cria wallet e guarda WALLET / PLAYER
#   aposta BET 25.00 t-1              → POST /wagering/transactions (ids prefixados com $RUN)
#   aposta ROLLBACK 25.00 rb-1 t-1    → com referenceExternalTransactionId = t-1
#   saldo | extrato | reconciliar | transacao t-1
#
# Requer: curl, jq. API em $API (padrão http://localhost:8080).

export API="${API:-http://localhost:8080}"

nova_wallet() {
  local amount="${1:-100.00}" currency="${2:-BRL}"
  export PLAYER="$(uuidgen | tr 'A-Z' 'a-z')"
  # prefixo por wallet: externalTransactionId é único por provedor para sempre,
  # então "t-1" de uma sessão anterior colidiria (409) numa sessão nova
  export RUN="${PLAYER:0:6}"
  local res
  res=$(curl -s -XPOST "$API/wallets" -H 'content-type: application/json' \
    -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"$amount\",\"currency\":\"$currency\"}}")
  export WALLET="$(echo "$res" | jq -r .id)"
  echo "$res" | jq .
  echo "→ WALLET=$WALLET  PLAYER=$PLAYER"
}

# aposta <KIND> <AMOUNT> <EXTERNAL_ID> [REFERENCE_EXTERNAL_ID] [CURRENCY]
aposta() {
  local kind="$1" amount="$2" ext="$RUN-$3" ref="$4" currency="${5:-BRL}"
  local refjson=""
  [ -n "$ref" ] && refjson=",\"referenceExternalTransactionId\":\"$RUN-$ref\""
  curl -s -w '\n← HTTP %{http_code}\n' -XPOST "$API/wagering/transactions" \
    -H 'content-type: application/json' \
    -H "Idempotency-Key: provider-a:$ext" \
    -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"$ext\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"$kind\",\"money\":{\"amount\":\"$amount\",\"currency\":\"$currency\"}$refjson}"
}

saldo()       { curl -s "$API/wallets/$WALLET" | jq .; }
extrato()     { curl -s "$API/wallets/$WALLET/ledger?limit=${1:-50}" | jq '.items[] | {direction, valor: .money.amount, antes: .balanceBefore.amount, depois: .balanceAfter.amount}'; }
reconciliar() { curl -s -XPOST "$API/wallets/$WALLET/reconciliation" | jq .; }
transacao()   { curl -s "$API/providers/provider-a/wagering/transactions/$RUN-$1" | jq .; }

# SQL direto no PostgreSQL do compose (para inspecionar ou tentar violar regras)
sql() { docker compose exec -T postgres psql -U wagering -d wagering -c "$1"; }

# Envia pela fila SQS em vez de HTTP: fila <KIND> <AMOUNT> <EXTERNAL_ID> [REFERENCE]
fila() { bun scripts/send-wager-message.ts "$WALLET" "$PLAYER" "$1" "$2" "$RUN-$3" ${4:+"$RUN-$4"}; }

echo "Atalhos carregados. API=$API"
