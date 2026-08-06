#!/usr/bin/env bash
# Mostra o QR code para parear o celular do bot.
# Se 'qrencode' estiver instalado, desenha no terminal; senao, mostra o codigo
# de pareamento e a URL do Evolution Manager.
#
# Uso: make qr

set -euo pipefail

cd "$(dirname "$0")/.."

set -a
# shellcheck disable=SC1091
source .env
set +a

API="http://localhost:8080"
INSTANCE="${EVOLUTION_INSTANCE:-racha}"
KEY="${EVOLUTION_API_KEY:?}"

STATE=$(curl -sS "${API}/instance/connectionState/${INSTANCE}" -H "apikey: ${KEY}" || echo '')

if echo "$STATE" | grep -q '"state":"open"'; then
  echo "Sessao ja esta conectada (state: open). Nada a fazer."
  echo "Para trocar de numero, rode: make reset-instance"
  exit 0
fi

echo "==> Solicitando QR code..."
RESP=$(curl -sS "${API}/instance/connect/${INSTANCE}" -H "apikey: ${KEY}")

# O campo "code" e o texto que o QR code codifica.
CODE=$(printf '%s' "$RESP" | grep -o '"code":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
PAIRING=$(printf '%s' "$RESP" | grep -o '"pairingCode":"[^"]*"' | head -1 | cut -d'"' -f4 || true)

if [[ -n "$CODE" ]] && command -v qrencode >/dev/null 2>&1; then
  echo
  qrencode -t ANSIUTF8 "$CODE"
  echo
  echo "No celular do bot: WhatsApp > Configuracoes > Dispositivos conectados"
  echo "                   > Conectar dispositivo > aponte para o QR acima."
else
  if [[ -z "$CODE" ]]; then
    echo "Nao consegui extrair o QR da resposta:"
    printf '%s\n' "$RESP"
  else
    echo "Instale 'qrencode' para ver o QR no terminal:"
    echo "  sudo apt install -y qrencode"
  fi
  echo
  echo "Alternativa: abra o Evolution Manager no navegador e leia o QR de la:"
  echo "  ${API}/manager"
  echo "  (apikey: veja EVOLUTION_API_KEY no seu .env)"
fi

if [[ -n "$PAIRING" ]]; then
  echo
  echo "Codigo de pareamento (alternativa ao QR): ${PAIRING}"
fi

echo
echo "Depois de parear, confirme com: make state"
