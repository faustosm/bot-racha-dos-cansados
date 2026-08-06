#!/usr/bin/env bash
# Cria a instancia da Evolution API e registra o webhook apontando para o bot.
# Idempotente: pode rodar quantas vezes quiser.
#
# Uso: make setup

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "ERRO: .env nao existe. Rode 'cp .env.example .env' e preencha." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

API="http://localhost:8080"
INSTANCE="${EVOLUTION_INSTANCE:-racha}"
KEY="${EVOLUTION_API_KEY:?EVOLUTION_API_KEY nao definido no .env}"
TOKEN="${WEBHOOK_TOKEN:?WEBHOOK_TOKEN nao definido no .env}"

# DNS interno do Compose: o container da Evolution alcanca o container do bot
# pelo nome do servico. Nunca "localhost" - la dentro seria ela mesma.
WEBHOOK_URL="http://bot:3000/webhook/evolution"

req() {
  curl -sS -X "$1" "${API}${2}" \
    -H "apikey: ${KEY}" \
    -H "Content-Type: application/json" \
    ${3:+-d "$3"}
}

echo "==> Verificando se a Evolution API responde em ${API}..."
if ! curl -sS --fail --max-time 5 "${API}" >/dev/null 2>&1; then
  echo "ERRO: Evolution API nao responde. Rode 'make up' e aguarde ficar healthy." >&2
  exit 1
fi

echo "==> Criando instancia '${INSTANCE}'..."
CREATE_BODY=$(cat <<JSON
{
  "instanceName": "${INSTANCE}",
  "qrcode": true,
  "integration": "WHATSAPP-BAILEYS"
}
JSON
)
CREATE_RESP=$(req POST "/instance/create" "$CREATE_BODY" || true)
if echo "$CREATE_RESP" | grep -qi "already in use\|already exists"; then
  echo "    instancia ja existe, seguindo."
else
  echo "    ok."
fi

echo "==> Registrando webhook -> ${WEBHOOK_URL}"
# Assinamos apenas os eventos necessarios. Assinar tudo enche o endpoint de
# ruido (presenca, chats, contatos) sem nenhum uso.
WEBHOOK_BODY=$(cat <<JSON
{
  "webhook": {
    "enabled": true,
    "url": "${WEBHOOK_URL}",
    "byEvents": false,
    "base64": false,
    "headers": {
      "Content-Type": "application/json",
      "x-webhook-token": "${TOKEN}"
    },
    "events": [
      "MESSAGES_UPSERT",
      "CONNECTION_UPDATE",
      "GROUP_PARTICIPANTS_UPDATE"
    ]
  }
}
JSON
)
req POST "/webhook/set/${INSTANCE}" "$WEBHOOK_BODY" >/dev/null
echo "    ok."

echo "==> Webhook registrado:"
req GET "/webhook/find/${INSTANCE}" || true
echo

echo
echo "Pronto. Agora rode 'make qr' para parear o celular do bot."
