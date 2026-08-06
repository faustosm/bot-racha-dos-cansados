.DEFAULT_GOAL := help
SHELL := /bin/bash

INSTANCE := $(shell grep -E '^EVOLUTION_INSTANCE=' .env 2>/dev/null | cut -d= -f2 || echo racha)
KEY      := $(shell grep -E '^EVOLUTION_API_KEY=' .env 2>/dev/null | cut -d= -f2)

.PHONY: help
help: ## Mostra esta ajuda
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

.PHONY: secrets
secrets: ## Gera segredos para colar no .env
	@echo "EVOLUTION_API_KEY=$$(openssl rand -hex 32)"
	@echo "WEBHOOK_TOKEN=$$(openssl rand -hex 32)"
	@echo "POSTGRES_PASSWORD=$$(openssl rand -hex 16)"

.PHONY: up
up: ## Sobe a stack (dev, com hot reload)
	docker compose up -d --build
	@echo
	@docker compose ps

.PHONY: up-prod
up-prod: ## Sobe a stack sem os overrides de dev (usar na VPS)
	docker compose -f docker-compose.yml up -d --build

.PHONY: down
down: ## Para a stack (mantem os volumes)
	docker compose down

.PHONY: restart
restart: ## Reinicia apenas o bot (apos mudar o .env)
	docker compose up -d --force-recreate bot

.PHONY: ps
ps: ## Estado dos containers
	docker compose ps

.PHONY: logs
logs: ## Logs de todos os servicos
	docker compose logs -f

.PHONY: logs-bot
logs-bot: ## Logs so do bot
	docker compose logs -f bot

.PHONY: logs-evolution
logs-evolution: ## Logs so da Evolution API
	docker compose logs -f evolution

.PHONY: setup
setup: ## Cria a instancia e registra o webhook
	@bash scripts/setup-instance.sh

.PHONY: qr
qr: ## Mostra o QR code para parear o celular do bot
	@bash scripts/qr.sh

.PHONY: state
state: ## Estado da conexao com o WhatsApp
	@curl -sS "http://localhost:8080/instance/connectionState/$(INSTANCE)" \
		-H "apikey: $(KEY)"; echo

.PHONY: webhook
webhook: ## Mostra o webhook registrado na instancia
	@curl -sS "http://localhost:8080/webhook/find/$(INSTANCE)" \
		-H "apikey: $(KEY)"; echo

.PHONY: health
health: ## Testa o healthcheck do bot
	@curl -sS http://localhost:3000/health; echo

.PHONY: reset-instance
reset-instance: ## Apaga a instancia para parear OUTRO numero (nao apaga o banco)
	@read -p "Isso desconecta o WhatsApp atual. Confirma? [y/N] " ok; \
	[[ "$$ok" == "y" ]] || exit 1; \
	curl -sS -X DELETE "http://localhost:8080/instance/delete/$(INSTANCE)" \
		-H "apikey: $(KEY)"; echo; \
	echo "Rode 'make setup' e depois 'make qr'."

.PHONY: backup
backup: ## Backup do Postgres e da sessao do WhatsApp
	@bash scripts/backup.sh

.PHONY: nuke
nuke: ## APAGA TUDO, inclusive volumes (perde a sessao pareada)
	@read -p "Isso apaga os volumes e exige reler o QR. Confirma? [y/N] " ok; \
	[[ "$$ok" == "y" ]] || exit 1; \
	docker compose down -v
