# Teste da reserva com o comitê — retomada

**Para a IA:** este arquivo é o contexto completo. Se o pedido for "vamos
iniciar os testes", leia daqui e execute a partir da seção *Roteiro*. Não é
preciso pedir explicação nenhuma ao usuário.

Escrito em 18/09/2026, para executar na **segunda, 21/09/2026**.

---

## O que é a reserva

A lista de linha fecha em 18. Até aqui, quem votava "✅ Vou" com a lista cheia
era só recusado, e a vaga que abrisse depois ia para quem visse a mensagem
primeiro — uma corrida que premia quem está com o celular na mão.

A reserva troca essa corrida por uma ordem registrada:

- A enquete ganha a 4ª opção **🕒 Reserva**.
- Quem toca em "Vou" com a lista cheia recebe o aviso de sempre e é convidado a
  tocar na reserva. Quem toca na reserva com vaga sobrando é mandado de volta
  para o "Vou".
- Quando alguém sai, o primeiro da reserva **sobe sozinho**, por ordem de
  chegada. Saída e subida saem no mesmo anúncio.
- A reserva tem teto de **6** (um time a mais), `RESERVA_TOTAL`.

Código na branch `reserva` (PR #1). **Não mergeado de propósito** — ver
*Depois do teste*.

## Por que o teste é assim

O bot é **um número de WhatsApp**, e a Evolution entrega cada evento para **uma
URL**. Não dá para dois bots ouvirem ao mesmo tempo. Então o teste:

- sobe um **segundo bot** (grupo do comitê, banco próprio, 2 vagas, reserva 4);
- **redireciona o webhook** para ele enquanto dura;
- **devolve** no fim.

Enquanto o teste roda, **o bot de produção não recebe nada**.

Por isso é na segunda: o racha é sábado, a lista fecha sábado 07:00, a
avaliação pós-jogo dispara sábado 12:00, e a próxima abertura é só quarta
12:00. Segunda não há nada rodando.

### O que pode se perder na janela do teste

- **Nota da avaliação pós-jogo.** Ela chega por webhook e é aceita até quarta
  12:00. Quem responder durante o teste tem a nota perdida. Por isso: janela
  curta.
- **Quem escrever no privado do bot** fala com o bot de teste, que tem banco
  vazio — vai responder que não há lista aberta. Numa segunda é improvável, mas
  acontece.

## A trava que existe por causa de um erro

Em 18/09/2026, subir o bot de teste **só para conferir o build** fez ele
publicar anúncio e enquete no grupo do comitê em 2 segundos. O banco de teste
estava vazio, então a faxina de boot (`recuperarAberturaPerdida`) concluiu que
a lista da semana nunca tinha aberto e "recuperou" — que é o comportamento
certo em produção. As mensagens foram apagadas.

Daí veio `AGENDADOR=desligado` (config.ts, server.ts), que o
`docker-compose.teste.yml` já usa: o bot de teste atende webhook normalmente e
**não toma iniciativa nenhuma**. A enquete do teste sai quando o script manda,
no passo 5, e só ali.

**Regra para qualquer bot de teste futuro:** subir container não é ação neutra.
Ou o agendador está desligado, ou o `GROUP_JID` está vazio — de preferência os
dois, até você ver nos logs que ele ficou quieto.

## Roteiro

### 1. Ligar

```bash
cd /root/bot-racha-dos-cansados          # o .env vive aqui
SRC_TESTE=/root/racha-reserva/bot/src make teste-iniciar
```

O script: guarda o webhook atual, cria o banco `racha_teste`, sobe o bot de
teste, **confere que ele responde**, só então redireciona o webhook, e publica
a enquete no grupo do comitê.

Confira a qualquer momento com `make teste-status`.

### 2. O que pedir ao comitê (7 pessoas)

A lista de teste tem **2 vagas** e reserva de **4**.

| # | Quem faz | O que deve acontecer |
|---|---|---|
| 1 | Duas pessoas tocam **✅ Vou** | entram; a segunda fecha a lista e o bot publica "fechou a lista" |
| 2 | A 3ª toca **✅ Vou** | recusa + convite: "toca em 🕒 Reserva" |
| 3 | A 3ª toca **🕒 Reserva** | "entrou na reserva (1º)" |
| 4 | A 4ª toca **👥 Vou com convidado** | mesma recusa e mesmo convite |
| 5 | A 4ª toca **🕒 Reserva** | entra como 2º, guardando o "+1 convidado" |
| 6 | 5ª e 6ª tocam **🕒 Reserva** | reserva chega a 4/4 |
| 7 | A 7ª toca **🕒 Reserva** | "a lista e a reserva estão cheias — pode tentar de novo" |
| 8 | Alguém da **lista** toca **❌ Não vou** | sai, o 1º da reserva **sobe sozinho**, e sai UMA mensagem com saída + subida + lista |
| 9 | Quem subiu recebe DM | "você subiu da reserva" |
| 10 | Alguém da **reserva** toca **❌ Não vou** | sai da fila, sem barulho no grupo |
| 11 | Qualquer um toca **🕒 Reserva** com vaga livre | "ainda tem vaga! clica em ✅ Vou" |

Digite `lista` no grupo para ver o bloco `🕒 Reservas 2/4` no rodapé.

### 3. Desligar — **obrigatório**

```bash
make teste-encerrar
```

Devolve o webhook **primeiro**, confere, e só então derruba o bot de teste e
apaga o banco.

Depois, a verificação que nenhum script faz: **mande `ping` no grupo do racha e
veja o bot responder `pong`**. Só isso prova que o caminho inteiro voltou.

> Se o webhook ficar apontado para o teste, o racha para **em silêncio**: a
> enquete de quarta não sobe, voto nenhum é lido, e ninguém recebe erro. É a
> única falha grave possível aqui.

## Depois do teste

**Se o comitê aprovar**, o merge entra **quarta, antes das 12:00**:

```bash
cd /root/bot-racha-dos-cansados
git merge reserva          # hot reload reinicia o bot; a migration 018 roda no boot
make logs-bot              # confirmar "migration aplicada" e nenhum erro
```

Quarta antes do meio-dia porque a enquete nova sobe às 12:00 já com as 4
opções, com a lista zerada. **Não mergear com uma enquete de 3 opções no ar**:
o WhatsApp não deixa editar enquete publicada, e o bot mandaria as pessoas
tocarem num botão que não existe.

**Se pedirem mudanças**, elas entram na branch `reserva` e o PR #1 é atualizado.

## Decisões já tomadas (não reabrir sem o comitê)

- Sem entrada automática na reserva: a pessoa escolhe, tocando na opção — assim
  a enquete mostra a verdade sobre onde cada um está.
- Promoção automática, sem prazo de confirmação.
- Ordem de chegada; o comitê **não** fura a fila.
- Com a reserva cheia, **convidado não entra mais** quando abre vaga.
- Titular sobe sem o convidado quando só abre uma vaga.
- Teto de 6 na reserva (4 no teste): fila longa faz o nome da pessoa se perder
  na lista publicada, e ela conclui que não reservou.
