# Bot do Racha — infraestrutura

Bot de confirmação de presença para o grupo do racha no WhatsApp.

Esta fase entrega **apenas a infraestrutura**: a stack em Docker rodando no WSL, com o
"cano" funcionando ponta a ponta — mensagem no grupo → webhook → backend → resposta no
grupo. A lógica de confirmação (lista, fila de espera, comandos) vem na fase seguinte.

## Como funciona

O bot **não é uma integração corporativa da Meta** — ele é um dispositivo pareado de uma
conta comum de WhatsApp, igual ao WhatsApp Web. A Evolution API mantém essa sessão e
converte tudo em HTTP: eventos chegam ao backend por webhook, e o backend responde
chamando a API.

```
Grupo do WhatsApp
      │  mensagem
      ▼
┌─────────────┐   webhook    ┌──────────┐
│  Evolution  │ ───────────► │   bot    │
│    API      │ ◄─────────── │ (Node/TS)│
└─────────────┘   sendText   └──────────┘
      │                            │
   Postgres (db evolution)    Postgres (db racha)
   Redis
```

Tudo roda numa rede bridge interna do Compose. Nada é exposto na internet — nem no WSL,
nem na VPS.

## Pré-requisitos

- Docker e Docker Compose
- Uma linha de WhatsApp dedicada para o bot, num celular que fique ligado
  (veja [Sobre o número do bot](#sobre-o-número-do-bot))

Se o Docker ainda não estiver instalado neste WSL:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# feche e reabra o terminal do WSL para o grupo valer
```

Opcional, para ver o QR code direto no terminal:

```bash
sudo apt install -y qrencode
```

## Subindo do zero

```bash
# 1. Configuração
cp .env.example .env
make secrets          # gera as chaves; cole os valores no .env

# 2. Sobe a stack
make up               # aguarde todos ficarem (healthy)
make ps

# 3. Cria a instância e registra o webhook
make setup

# 4. Pareia o celular do bot
make qr               # leia o QR com o celular do bot
make state            # deve responder "state":"open"
```

### 5. Descobrir o JID do grupo

O `GROUP_JID` começa vazio de propósito. Adicione o bot a um **grupo de teste** (2-3
pessoas — não use o grupo real ainda), mande qualquer mensagem lá e veja o log:

```bash
make logs-bot
```

Vai aparecer:

```
GROUP_JID nao configurado. Copie este groupJid para o .env e rode "make restart".
  groupJid: "120363XXXXXXXXXXXX@g.us"
```

Cole esse valor em `GROUP_JID` no `.env` e:

```bash
make restart
```

### 6. Testar o cano

Mande `ping` no grupo de teste. O bot deve reagir com 🏓 e responder `pong`.

Se responder, a infraestrutura está pronta.

## Verificação completa

| # | Comando | Esperado |
|---|---|---|
| 1 | `make ps` | 4 serviços `(healthy)` |
| 2 | `make health` | `{"status":"ok"}` |
| 3 | `make webhook` | os 3 eventos registrados |
| 4 | `make state` | `"state":"open"` |
| 5 | `ping` no grupo | bot responde `pong` |
| 6 | `make down && make up` | volta sem pedir QR de novo |
| 7 | `make backup` | dois arquivos com tamanho > 0 |

O passo 6 é o mais importante antes de ir para a VPS: se pedir QR de novo, o volume
`evolution_instances` não está persistindo.

## Comandos

```
make help            lista tudo
make up              sobe a stack (dev, com hot reload)
make down            para a stack (mantém os volumes)
make restart         reinicia só o bot (após mudar o .env)
make logs-bot        logs do bot
make setup           cria instância + registra webhook
make qr              QR code para parear
make state           estado da conexão com o WhatsApp
make backup          backup do Postgres + sessão do WhatsApp
make reset-instance  troca o número pareado
make nuke            apaga tudo, inclusive volumes
```

## Sobre o número do bot

O bot usa uma **linha pré-paga dedicada num celular antigo ligado 24/7**. Nunca o número
pessoal: este é um caminho não-oficial do WhatsApp e existe risco de banimento — se
acontecer, o prejuízo fica numa linha descartável.

Três cuidados que derrubam o bot se ignorados:

- **O celular precisa ficar ligado e com internet.** O WhatsApp desconecta todos os
  dispositivos pareados se o aparelho principal ficar **14 dias** sem se conectar.
- **Desative economia de bateria agressiva e atualização automática** no aparelho. São as
  duas causas mais comuns de o celular sumir da rede sem ninguém perceber.
- **Mantenha a linha ativa.** Pré-pago exige recarga periódica (tipicamente a cada 3-6
  meses, varia por operadora). Linha desativada derruba a conta junto.

O evento `CONNECTION_UPDATE` é o alarme: quando a sessão cai, o bot loga em nível `warn`.

Números **VoIP/virtuais** (Google Voice, sites de SMS) não funcionam — o WhatsApp bloqueia
o registro. **eSIM de operadora funciona** normalmente: é um número móvel real.

## Levando para a VPS

A stack é a mesma. O que muda:

1. Copie o projeto e crie o `.env` lá (com senhas novas).
2. Suba **sem os overrides de dev**, que publicam portas:
   ```bash
   make up-prod
   ```
3. Restaure o backup da sessão para não precisar reparear — o comando de restauração é
   impresso no final do `make backup`.

`restart: unless-stopped` faz a stack voltar sozinha após reboot da VPS.

## Notas técnicas

- **Evolution API v2 não suporta SQLite.** Exige PostgreSQL; a versão está pinada em
  `v2.3.7` (a tag `latest` aponta para release candidates).
- **O bot usa o mesmo Postgres**, num database separado (`racha`). Uma tecnologia de
  banco, um `pg_dumpall` cobre tudo.
- **O webhook responde `200` antes de processar.** A Evolution reentrega com backoff
  exponencial até 10 vezes; demorar geraria mensagens duplicadas no grupo.
- **Histórico do grupo não é persistido** (`DATABASE_SAVE_DATA_*=false`). O banco não
  cresce sem controle e não guardamos conversa de terceiros.
- **Participantes de grupo vêm como `@lid`**, não como telefone — o WhatsApp oculta os
  números. A identificação dos jogadores na próxima fase será por LID.
- O volume `evolution_instances` guarda a sessão pareada. **Perdê-lo significa reler o
  QR code** — por isso entra no backup.
