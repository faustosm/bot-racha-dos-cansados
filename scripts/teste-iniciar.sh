#!/usr/bin/env bash
#
# Prepara e liga o ambiente de teste (ver TESTE-RESERVA.md).
#
# Ordem importa: o webhook so e redirecionado no FIM, depois de o bot de teste
# estar de pe e respondendo. Redirecionar antes deixaria uma janela em que
# evento nenhum tem dono - e evento entregue a ninguem nao volta.
#
# Uso:  make teste-iniciar
set -euo pipefail

cd "$(dirname "$0")/.."


SRC_TESTE="${SRC_TESTE:-/root/racha-reserva/bot/src}"
# --project-directory aponta para a PRODUCAO de proposito: e la que vive o
# .env com os segredos e o JID do comite, e o compose resolve `env_file` e
# ${VAR} a partir dele. Sem isto, sobe tudo com variavel vazia.
PROD_DIR="${PROD_DIR:-/root/bot-racha-dos-cansados}"
COMPOSE=(docker compose -f "$PWD/docker-compose.teste.yml" --project-directory "$PROD_DIR" -p racha-teste)
API="http://localhost:8080"
INSTANCE=$(grep -E '^EVOLUTION_INSTANCE=' "${PROD_DIR:-/root/bot-racha-dos-cansados}"/.env | cut -d= -f2- | tr -d '"')
KEY=$(grep -E '^EVOLUTION_API_KEY=' "${PROD_DIR:-/root/bot-racha-dos-cansados}"/.env | cut -d= -f2- | tr -d '"')
TOKEN=$(grep -E '^WEBHOOK_TOKEN=' "${PROD_DIR:-/root/bot-racha-dos-cansados}"/.env | cut -d= -f2- | tr -d '"')
PGU=$(grep -E '^POSTGRES_USER=' "${PROD_DIR:-/root/bot-racha-dos-cansados}"/.env | cut -d= -f2- | tr -d '"')
COMITE=$(grep -E '^GRUPO_ADMIN_JID=' "${PROD_DIR:-/root/bot-racha-dos-cansados}"/.env | cut -d= -f2- | tr -d '"')

if [[ -z "$COMITE" ]]; then
  echo "GRUPO_ADMIN_JID vazio no .env - sem ele o bot de teste nao tem onde falar." >&2
  exit 1
fi

if [[ ! -d "$SRC_TESTE" ]]; then
  echo "codigo de teste nao encontrado em $SRC_TESTE" >&2
  exit 1
fi

echo "==> 1/5 Guardando o webhook atual (para o teste-encerrar devolver)"
mkdir -p .teste
curl -sS "${API}/webhook/find/${INSTANCE}" -H "apikey: ${KEY}" \
  | tee .teste/webhook-producao.json | head -c 200; echo

echo "==> 2/5 Criando o banco racha_teste (vazio, separado do racha)"
docker compose --project-directory "$PROD_DIR" exec -T postgres psql -q -U "$PGU" -d postgres \
  -c "drop database if exists racha_teste;" -c "create database racha_teste;"

echo "==> 3/5 Subindo o bot de teste (grupo do comite, 2 vagas, reserva 4)"
echo "    com AGENDADOR=desligado: ele nao publica nada por conta propria"
SRC_TESTE="$SRC_TESTE" "${COMPOSE[@]}" up -d --build

echo "    esperando ficar de pe..."
for i in {1..30}; do
  if docker exec racha_bot_teste wget -qO- http://localhost:3000/health 2>/dev/null | grep -q ok; then
    echo "    bot de teste respondendo."
    break
  fi
  [[ $i -eq 30 ]] && { echo "bot de teste nao subiu - veja: docker logs racha_bot_teste" >&2; exit 1; }
  sleep 2
done

echo "==> 4/5 Redirecionando o webhook para o bot de teste"
curl -sS -X POST "${API}/webhook/set/${INSTANCE}" \
  -H "apikey: ${KEY}" -H 'Content-Type: application/json' \
  -d "{\"webhook\":{\"enabled\":true,\"url\":\"http://bot-teste:3000/webhook/evolution\",\"byEvents\":false,\"base64\":false,\"headers\":{\"x-webhook-token\":\"${TOKEN}\"},\"events\":[\"MESSAGES_UPSERT\",\"MESSAGES_UPDATE\",\"CONNECTION_UPDATE\"]}}" >/dev/null
echo "    webhook agora aponta para: $(curl -sS "${API}/webhook/find/${INSTANCE}" -H "apikey: ${KEY}" | grep -o '"url":"[^"]*"')"

# Primeira e unica coisa que sai no grupo, e so porque foi mandado aqui.
echo "==> 5/5 Abrindo a lista de teste e publicando a enquete no grupo do comite"
docker exec racha_bot_teste npx tsx src/dev/simular-abertura.ts

cat <<'FIM'

============================================================
 AMBIENTE DE TESTE NO AR
============================================================
 A partir de agora o bot RESPONDE NO GRUPO DO COMITE e o bot
 de producao NAO recebe nada. Roteiro do teste e o que pode
 se perder nessa janela: TESTE-RESERVA.md

 QUANDO TERMINAR, SEMPRE:   make teste-encerrar
============================================================
FIM
