#!/usr/bin/env bash
# Backup da stack: dump do Postgres (Evolution + bot) e a sessao pareada do
# WhatsApp. Perder o volume evolution_instances significa reler o QR code.
#
# Uso: make backup

set -euo pipefail

cd "$(dirname "$0")/.."

set -a
# shellcheck disable=SC1091
source .env
set +a

STAMP=$(date +%Y%m%d-%H%M%S)
DEST="backups/${STAMP}"
mkdir -p "$DEST"

echo "==> Dump do Postgres (todos os databases)..."
docker compose exec -T postgres \
  pg_dumpall -U "${POSTGRES_USER}" \
  | gzip > "${DEST}/postgres.sql.gz"

echo "==> Sessao do WhatsApp (volume evolution_instances)..."
# Container efemero monta o volume e empacota o conteudo.
docker run --rm \
  -v racha_evolution_instances:/data:ro \
  -v "$(pwd)/${DEST}":/backup \
  alpine tar czf /backup/evolution_instances.tar.gz -C /data .

echo
echo "Backup em ${DEST}:"
ls -lh "$DEST"

echo
echo "Para restaurar a sessao:"
echo "  docker run --rm -v racha_evolution_instances:/data \\"
echo "    -v \$(pwd)/${DEST}:/backup alpine \\"
echo "    sh -c 'rm -rf /data/* && tar xzf /backup/evolution_instances.tar.gz -C /data'"
