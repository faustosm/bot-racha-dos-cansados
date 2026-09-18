import type { PoolClient } from 'pg';
import { query, queryOne, transaction } from '../db.js';
import type { ItemReserva } from './tipos.js';

/**
 * A reserva (lista de espera) da lista de LINHA.
 *
 * Este modulo so mexe na tabela `reserva`. Quem cruza reserva com vaga -
 * decidir se cabe, inserir quem subiu em `inscricao` - e `inscricao.ts`, que
 * importa daqui. A direcao e unica de proposito: se este modulo importasse
 * `inscricao.ts` de volta (por causa de `contarComLock`), teriamos um ciclo.
 *
 * Goleiro nao tem reserva: teto proprio, e costuma faltar em vez de sobrar.
 */

export type { ItemReserva } from './tipos.js';

/** Quem acabou de subir da reserva para a lista. */
export interface Promovido {
  readonly jogadorId: number;
  readonly nome: string;
  readonly querConvidado: boolean;
}

const SQL_RESERVA = `
  select r.id,
         r.jogador_id,
         coalesce(j.nome_escolhido, j.nome) as nome,
         r.quer_convidado
    from reserva r
    join jogador j on j.id = r.jogador_id
   where r.partida_id = $1
     and r.saiu_em is null
   order by r.criado_em, r.id
`;

interface LinhaReserva {
  id: number;
  jogador_id: number;
  nome: string;
  quer_convidado: boolean;
}

const paraItem = (r: LinhaReserva): ItemReserva => ({
  id: r.id,
  jogadorId: r.jogador_id,
  nome: r.nome,
  querConvidado: r.quer_convidado,
});

/** A reserva inteira, em ordem de chegada - a ordem em que vao subir. */
export async function listar(partidaId: number): Promise<ItemReserva[]> {
  const rows = await query<LinhaReserva>(SQL_RESERVA, [partidaId]);
  return rows.map(paraItem);
}

/** Em que lugar da fila essa pessoa esta, se estiver. 1 = proxima a subir. */
export async function posicao(
  partidaId: number,
  jogadorId: number,
): Promise<number | undefined> {
  const r = await queryOne<{ posicao: string }>(
    `select posicao from (
       select jogador_id,
              row_number() over (order by criado_em, id) as posicao
         from reserva
        where partida_id = $1 and saiu_em is null
     ) f where jogador_id = $2`,
    [partidaId, jogadorId],
  );
  return r ? Number(r.posicao) : undefined;
}

export interface Entrada {
  readonly posicao: number;
  /** Ja estava na reserva: nao mexeu na ordem, e o grupo nao precisa saber. */
  readonly jaEstava: boolean;
}

/**
 * Poe alguem na reserva, dentro de uma transacao ja aberta.
 *
 * Idempotente por construcao (`reserva_jogador_unica`): quem ja esta na fila
 * so tem `quer_convidado` atualizado e mantem o lugar. Isso cobre a reentrega
 * do webhook e a troca de "Vou" para "Vou com convidado" - dizer que vai
 * levar alguem nao pode jogar a pessoa pro fim da fila.
 */
export async function entrarNaTransacao(
  client: PoolClient,
  partidaId: number,
  jogadorId: number,
  querConvidado: boolean,
): Promise<Entrada> {
  const atual = await client.query<{ id: number }>(
    `select id from reserva
      where partida_id = $1 and jogador_id = $2 and saiu_em is null`,
    [partidaId, jogadorId],
  );
  const jaEstava = atual.rowCount !== 0;

  if (jaEstava) {
    // So acrescenta a intencao de convidado - nunca tira, e nunca mexe no
    // criado_em. Quem ja esta na fila mantem o lugar.
    if (querConvidado) {
      await client.query(
        'update reserva set quer_convidado = true where id = $1',
        [atual.rows[0]?.id],
      );
    }
  } else {
    await client.query(
      `insert into reserva (partida_id, jogador_id, quer_convidado)
       values ($1, $2, $3)`,
      [partidaId, jogadorId, querConvidado],
    );
  }

  const { rows } = await client.query<{ posicao: string }>(
    `select posicao from (
       select jogador_id,
              row_number() over (order by criado_em, id) as posicao
         from reserva
        where partida_id = $1 and saiu_em is null
     ) f where jogador_id = $2`,
    [partidaId, jogadorId],
  );
  return { posicao: Number(rows[0]?.posicao ?? 0), jaEstava };
}

/** Sai da reserva por vontade propria. Falso quando nem estava nela. */
export async function sair(
  partidaId: number,
  jogadorId: number,
): Promise<boolean> {
  return transaction(async (client) => {
    const { rowCount } = await client.query(
      `update reserva set saiu_em = now(), motivo_saida = 'desistiu'
        where partida_id = $1 and jogador_id = $2 and saiu_em is null`,
      [partidaId, jogadorId],
    );
    return (rowCount ?? 0) > 0;
  });
}

/**
 * Tira os proximos `quantos` da fila e devolve quem eram, na ordem.
 *
 * So marca a saida da reserva - inserir na lista e com `inscricao.ts`, na
 * MESMA transacao. Se o insert falhar, o rollback desfaz esta marcacao junto:
 * ninguem perde o lugar por causa de uma vaga que nao chegou a existir.
 */
export async function retirarProximos(
  client: PoolClient,
  partidaId: number,
  quantos: number,
): Promise<Promovido[]> {
  if (quantos <= 0) return [];

  // Le em ordem e trava as linhas ANTES de marcar: o `returning` de um UPDATE
  // nao garante ordem nenhuma, e a ordem aqui e o produto - e ela que decide
  // quem sobe e em que sequencia o grupo le os nomes.
  const { rows } = await client.query<LinhaReserva>(
    `select r.id,
            r.jogador_id,
            coalesce(j.nome_escolhido, j.nome) as nome,
            r.quer_convidado
       from reserva r
       join jogador j on j.id = r.jogador_id
      where r.partida_id = $1 and r.saiu_em is null
      order by r.criado_em, r.id
      limit $2
      for update of r`,
    [partidaId, quantos],
  );
  if (!rows.length) return [];

  await client.query(
    `update reserva set saiu_em = now(), motivo_saida = 'promovido'
      where id = any($1::int[])`,
    [rows.map((r) => r.id)],
  );

  return rows.map((r) => ({
    jogadorId: r.jogador_id,
    nome: r.nome,
    querConvidado: r.quer_convidado,
  }));
}

/**
 * Sabado 07:00: a lista fecha e a reserva morre junto. Devolve quem ficou de
 * fora, para o anuncio de fechamento citar - senao eles ficam esperando um
 * chamado que nao vem mais.
 */
export async function fechar(partidaId: number): Promise<ItemReserva[]> {
  const restantes = await listar(partidaId);
  if (restantes.length) {
    await query(
      `update reserva set saiu_em = now(), motivo_saida = 'fechou'
        where partida_id = $1 and saiu_em is null`,
      [partidaId],
    );
  }
  return restantes;
}
