import { query, queryOne } from '../db.js';
import { config } from '../config.js';
import { janelas, proximoSabado } from './datas.js';
import type { Partida, StatusPartida } from './tipos.js';

export { isoDate, janelas, proximoSabado } from './datas.js';

const COLUNAS = `id, data_jogo, abre_fixos, abre_convidados, fecha_em,
                 vagas_total, vagas_goleiro, status,
                 enquete_id, enquete_segredo, enquete_criador, encerrada_em`;

/**
 * Cria a partida do proximo sabado se ainda nao existir. Idempotente: o
 * agendador pode disparar duas vezes (restart do container) sem duplicar.
 */
export async function garantirPartida(agora = new Date()): Promise<Partida> {
  const dataJogo = proximoSabado(agora);
  const { abreFixos, abreConvidados, fechaEm } = janelas(dataJogo);

  const criada = await queryOne<Partida>(
    `insert into partida
       (data_jogo, abre_fixos, abre_convidados, fecha_em, vagas_total, vagas_goleiro)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (data_jogo) do nothing
     returning ${COLUNAS}`,
    [
      dataJogo,
      abreFixos,
      abreConvidados,
      fechaEm,
      config.VAGAS_TOTAL,
      config.VAGAS_GOLEIRO,
    ],
  );
  if (criada) return criada;

  const existente = await queryOne<Partida>(
    `select ${COLUNAS} from partida where data_jogo = $1`,
    [dataJogo],
  );
  if (!existente) throw new Error(`partida ${dataJogo} sumiu apos o insert`);
  return existente;
}

/**
 * A partida em andamento.
 *
 * O filtro por `fecha_em` e essencial, nao redundante com o status: o status so
 * vira 'fechada' pelo cron de sabado 09:00, e se o container estiver parado
 * naquele minuto (deploy, reboot, queda) a partida daquela semana fica 'aberta'
 * para sempre. Como a ordenacao e por data_jogo, ela sombrearia todos os rachas
 * seguintes e o bot passaria a responder "a lista nao esta aberta agora" para
 * todo mundo, sem saida a nao ser UPDATE manual no banco.
 */
export async function partidaAtual(): Promise<Partida | undefined> {
  return queryOne<Partida>(
    `select ${COLUNAS} from partida
      where status <> 'fechada'
        and fecha_em > now()
      order by data_jogo
      limit 1`,
  );
}

/**
 * A partida mais recente, inclusive fechada. Para exibicao apenas: e o que
 * permite consultar a lista final depois do jogo comecar.
 */
export async function partidaParaLeitura(): Promise<Partida | undefined> {
  return queryOne<Partida>(
    `select ${COLUNAS} from partida order by data_jogo desc limit 1`,
  );
}

export async function partidaPorId(id: number): Promise<Partida | undefined> {
  return queryOne<Partida>(`select ${COLUNAS} from partida where id = $1`, [id]);
}

/**
 * Fecha o que ja passou da hora. Roda no boot e de hora em hora, para o bot se
 * curar sozinho quando o cron de sabado nao rodou.
 */
export async function fecharVencidas(): Promise<number> {
  const linhas = await query<{ id: number }>(
    `update partida set status = 'fechada'
      where status <> 'fechada' and fecha_em <= now()
      returning id`,
  );
  return linhas.length;
}

/** A partida de uma enquete, para casar o voto que chegou com o racha certo. */
export async function partidaPorEnquete(
  enqueteId: string,
): Promise<Partida | undefined> {
  return queryOne<Partida>(
    `select ${COLUNAS} from partida where enquete_id = $1`,
    [enqueteId],
  );
}

/**
 * Guarda o que permite decifrar votos depois. O `messageSecret` so vem na
 * resposta do envio da enquete - perdeu, perdeu.
 */
export async function registrarEnquete(
  partidaId: number,
  enquete: { id: string; segredoBase64: string; criadorJid?: string | undefined },
): Promise<void> {
  await query(
    `update partida
        set enquete_id = $2, enquete_segredo = $3, enquete_criador = $4
      where id = $1`,
    [partidaId, enquete.id, enquete.segredoBase64, enquete.criadorJid ?? null],
  );
}

/**
 * A partida que ja aconteceu e ainda nao teve o encerramento anunciado.
 *
 * Guardar `encerrada_em` e o que impede o grupo de receber "acabou" duas vezes
 * quando o container reinicia perto do horario do cron.
 */
export async function partidaAEncerrar(): Promise<Partida | undefined> {
  return queryOne<Partida>(
    `select ${COLUNAS} from partida
      where fecha_em <= now() and encerrada_em is null
      order by data_jogo desc
      limit 1`,
  );
}

export async function marcarEncerrada(id: number): Promise<void> {
  await query('update partida set encerrada_em = now() where id = $1', [id]);
}

export async function definirStatus(
  id: number,
  status: StatusPartida,
): Promise<void> {
  await query('update partida set status = $2 where id = $1', [id, status]);
}

/** Convidados so podem ser adicionados a partir de quinta 12:00. */
export function convidadosLiberados(
  partida: Partida,
  agora = new Date(),
): boolean {
  return agora >= new Date(partida.abre_convidados);
}

export function listaAberta(partida: Partida, agora = new Date()): boolean {
  return (
    partida.status !== 'fechada' &&
    agora >= new Date(partida.abre_fixos) &&
    agora < new Date(partida.fecha_em)
  );
}
