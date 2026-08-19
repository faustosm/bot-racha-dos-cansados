import { query, queryOne } from '../db.js';
import { config } from '../config.js';
import { janelaAvaliacao, janelas, proximoSabado } from './datas.js';
import type { Partida, StatusPartida } from './tipos.js';

export { isoDate, janelaAvaliacao, janelas, proximoSabado } from './datas.js';

// avaliacao_enquete_id/segredo/criador (migration 012) nao entram aqui: a
// partir da migration 013 a enquete de avaliacao passou a ser por PESSOA,
// guardada em `avaliacao` - essas 3 colunas de `partida` ficaram sem leitor
// (vestigio historico, mesmo caso de `lista_lotou_em`).
const COLUNAS = `id, data_jogo, abre_fixos, abre_convidados, fecha_em,
                 vagas_total, vagas_goleiro, status,
                 enquete_id, enquete_segredo, enquete_criador,
                 encerrada_em, encerra_em, abrindo_em`;

/**
 * Cria a partida do proximo sabado se ainda nao existir. Idempotente: o
 * agendador pode disparar duas vezes (restart do container) sem duplicar.
 */
export async function garantirPartida(agora = new Date()): Promise<Partida> {
  const dataJogo = proximoSabado(agora);
  const { abreFixos, abreConvidados, fechaEm, encerraEm } = janelas(dataJogo);

  const criada = await queryOne<Partida>(
    `insert into partida
       (data_jogo, abre_fixos, abre_convidados, fecha_em, encerra_em,
        vagas_total, vagas_goleiro)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (data_jogo) do nothing
     returning ${COLUNAS}`,
    [
      dataJogo,
      abreFixos,
      abreConvidados,
      fechaEm,
      encerraEm,
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
 * A partida que ja aconteceu e ainda nao teve o encerramento (avaliacao
 * pos-jogo) anunciado.
 *
 * Filtra por `encerra_em`, nao por `fecha_em`: `fecha_em` e 2h ANTES do jogo
 * (fechamento da lista), enquanto o encerramento e DEPOIS que a bola parou de
 * rolar. Guardar `encerrada_em` e o que impede o grupo de receber a enquete
 * de nota duas vezes quando o container reinicia perto do horario do cron.
 */
export async function partidaAEncerrar(): Promise<Partida | undefined> {
  return queryOne<Partida>(
    `select ${COLUNAS} from partida
      where encerra_em <= now() and encerrada_em is null
      order by data_jogo desc
      limit 1`,
  );
}

export async function marcarEncerrada(id: number): Promise<void> {
  await query('update partida set encerrada_em = now() where id = $1', [id]);
}

/**
 * Ate quando a avaliacao pos-jogo aceita nota - ver `janelaAvaliacao` em
 * domain/datas.ts para o motivo do prazo (quarta 12:00, quando a proxima
 * partida abre pros fixos).
 */
export function avaliacaoAberta(partida: Partida, agora = new Date()): boolean {
  return agora < janelaAvaliacao(partida.data_jogo);
}

export async function definirStatus(
  id: number,
  status: StatusPartida,
): Promise<boolean> {
  // Condicional de proposito: com duas confirmacoes simultaneas, as duas leem
  // status 'aberta' e as duas veem a lista cheia. Sem o `where status <> $2`,
  // ambas anunciariam "RACHA COMPLETO". Assim so uma muda de fato, e quem
  // chama usa o retorno para saber se foi ela.
  const linhas = await query<{ id: number }>(
    'update partida set status = $2 where id = $1 and status <> $2 returning id',
    [id, status],
  );
  return linhas.length > 0;
}

/**
 * Reserva atomicamente o direito de anunciar a abertura desta partida.
 *
 * `abrirParaFixos` pode disparar duas vezes quase ao mesmo tempo - pelo cron
 * de quarta 12:00 e pela faxina horaria de recuperacao, que roda no mesmo
 * minuto. Sem esta reserva as duas leem `enquete_id` nulo (o UPDATE que o
 * grava so acontece segundos depois, apos o round-trip com a Evolution API) e
 * as duas anunciam - foi o que gerou a enquete duplicada de 19/08/2026. So
 * quem ganha este UPDATE segue em frente.
 *
 * A reserva expira em 5 minutos: se o processo cair no meio da abertura (ou a
 * Evolution falhar e `enquete_id` nunca for gravado), a proxima tentativa
 * horaria nao pode ficar travada esperando uma reserva que ninguem vai
 * liberar - a recuperacao existe justamente para nao deixar a semana morrer
 * em silencio.
 */
export async function reservarAbertura(id: number): Promise<boolean> {
  const linhas = await query<{ id: number }>(
    `update partida set abrindo_em = now()
      where id = $1
        and enquete_id is null
        and (abrindo_em is null or abrindo_em < now() - interval '5 minutes')
      returning id`,
    [id],
  );
  return linhas.length > 0;
}

/** Convidados so podem ser adicionados a partir de quinta 12:00. */
export function convidadosLiberados(
  partida: Partida,
  agora = new Date(),
): boolean {
  return agora >= new Date(partida.abre_convidados);
}

/**
 * Sexta e sabado: ultimos dias com tempo de repor quem desistiu antes do
 * jogo. Quarta e quinta ainda sobra a semana inteira - avisar toda saida
 * nesses dias so polui o grupo a toa (o digest das 19h ja cobre).
 */
export function diaDeAvisarSaida(agora = new Date()): boolean {
  const dia = agora.getDay();
  return dia === 5 || dia === 6;
}

export function listaAberta(partida: Partida, agora = new Date()): boolean {
  return (
    partida.status !== 'fechada' &&
    agora >= new Date(partida.abre_fixos) &&
    agora < new Date(partida.fecha_em)
  );
}
