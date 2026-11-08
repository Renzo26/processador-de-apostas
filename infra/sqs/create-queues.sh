#!/bin/sh
# Cria as filas FIFO (principal + DLQ) com redrive policy.
# Idempotente: create-queue com os mesmos atributos não falha se a fila já existe.
set -eu

aws_sqs() { aws --endpoint-url "$SQS_ENDPOINT" sqs "$@"; }

DLQ_URL=$(aws_sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false \
  --query QueueUrl --output text)

DLQ_ARN=$(aws_sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

# RedrivePolicy é uma string JSON dentro do JSON de atributos (aspas escapadas).
REDRIVE_ESCAPED="{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"$SQS_MAX_RECEIVE_COUNT\\\"}"

cat > /tmp/main-queue-attrs.json <<JSON
{
  "FifoQueue": "true",
  "ContentBasedDeduplication": "false",
  "VisibilityTimeout": "30",
  "RedrivePolicy": "$REDRIVE_ESCAPED"
}
JSON

aws_sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes file:///tmp/main-queue-attrs.json >/dev/null

# Fila de eventos de integração publicados pela outbox (consumidores downstream).
aws_sqs create-queue \
  --queue-name wallet-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false >/dev/null

echo "Filas SQS prontas:"
aws_sqs list-queues --output text
