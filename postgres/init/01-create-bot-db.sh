#!/bin/bash
# Cria o database do bot ao lado do database da Evolution API, na mesma
# instancia do Postgres. Assim a stack tem uma unica tecnologia de banco e um
# unico pg_dumpall cobre tudo.
#
# ATENCAO: /docker-entrypoint-initdb.d so e executado na PRIMEIRA inicializacao
# do Postgres, com o volume vazio. Se o volume ja existir, crie na mao:
#
#   docker compose exec postgres psql -U "$POSTGRES_USER" -d postgres \
#     -c "CREATE DATABASE racha OWNER racha;"

set -euo pipefail

BOT_DB="${BOT_DB:-racha}"

echo "init: criando database '${BOT_DB}' para o bot..."

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
	CREATE DATABASE "${BOT_DB}" OWNER "${POSTGRES_USER}";
EOSQL

echo "init: database '${BOT_DB}' criado."
