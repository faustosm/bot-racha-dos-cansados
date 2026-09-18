#!/usr/bin/env bash
#
# Desliga o ambiente de teste e devolve o bot de producao ao ar.
#
# Este script e o que importa de verdade. Se o webhook ficar apontado pro bot
# de teste, o racha para de funcionar EM SILENCIO: a enquete de quarta nao
# sobe, voto nenhum e lido, e ninguem recebe erro - so param de acontecer
# coisas. Por isso ele devolve o webhook PRIMEIRO, confere depois, e so entao
# derruba o resto.
#
# Uso:  make teste-encerrar
set -euo pipefail

cd "$(dirname "$0")/.."

PROD_DIR="${PROD_DIR:-/root/bot-racha-dos-cansados}"
COMPOSE=(docker compose -f "$PWD/docker-compose.teste.yml" --project-directory "$PROD_DIR" -p racha-teste)
API="http://localhost:8080"
INSTANCE=$(grep -E '^EVOLUTION_INSTANCE=' "${PROD_DIR:-/root/bot-racha-dos-cansados}"/.env | cut -d= -f2- | tr -d '"')
KEY=$(grep -E '^EVOLUTION_API_KEY=' "${PROD_DIR:-/root/bot-racha-dos-cansados}"/.env | cut -d= -f2- | tr -d '"')
TOKEN=$(grep -E '^WEBHOOK_TOKEN=' "${PROD_DIR:-/root/bot-racha-dos-cansados}"/.env | cut -d= -f2- | tr -d '"')
PGU=$(grep -E '^POSTGRES_USER=' "${PROD_DIR:-/root/bot-racha-dos-cansados}"/.env | cut -d= -f2- | tr -d '"')

echo "==> 1/4 Devolvendo o webhook para o bot de producao"
curl -sS -X POST "${API}/webhook/set/${INSTANCE}" \
  -H "apikey: ${KEY}" -H 'Content-Type: application/json' \
  -d "{\"webhook\":{\"enabled\":true,\"url\":\"http://bot:3000/webhook/evolution\",\"byEvents\":false,\"base64\":false,\"headers\":{\"x-webhook-token\":\"${TOKEN}\"},\"events\":[\"MESSAGES_UPSERT\",\"MESSAGES_UPDATE\",\"CONNECTION_UPDATE\"]}}" >/dev/null

echo "==> 2/4 Conferindo"
URL=$(curl -sS "${API}/webhook/find/${INSTANCE}" -H "apikey: ${KEY}" | grep -o '"url":"[^"]*"' | cut -d'"' -f4)
echo "    webhook: ${URL}"
if [[ "$URL" != "http://bot:3000/webhook/evolution" ]]; then
  echo "" >&2
  echo "!! O WEBHOOK NAO VOLTOU. O racha esta fora do ar ate isso ser resolvido." >&2
  echo "!! Rode de novo, ou manualmente:  make setup" >&2
  exit 1
fi

echo "==> 3/4 Derrubando o bot de teste e apagando o banco de teste"
"${COMPOSE[@]}" down --remove-orphans 2>/dev/null || true
docker compose --project-directory "$PROD_DIR" exec -T postgres psql -q -U "$PGU" -d postgres \
  -c "drop database if exists racha_teste;" || true

echo "==> 4/4 Conferindo a producao"
docker compose --project-directory "$PROD_DIR" ps --format '{{.Name}} {{.Status}}' | grep -E 'racha_bot|racha_evolution'
curl -sS "${API}/instance/connectionState/${INSTANCE}" -H "apikey: ${KEY}"; echo

cat <<'FIM'

============================================================
 AMBIENTE DE TESTE DESLIGADO
============================================================
 Falta UMA verificacao, que nenhum script faz sozinho:

   mande "ping" no grupo do racha e veja o bot responder.

 So isso prova que o caminho inteiro (WhatsApp -> Evolution
 -> bot de producao) voltou. Nao pule.
============================================================
FIM
