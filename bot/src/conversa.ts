import { query, queryOne } from './db.js';
import { config } from './config.js';
import type { Posicao } from './domain/tipos.js';

// Estado do dialogo no privado. Fica no banco, nao em memoria: o container
// reinicia (deploy, hot reload) e a pessoa nao pode ficar com uma pergunta
// pendurada que o bot nao sabe mais responder.

export type Estado =
  /** Perguntou se vai levar convidados; espera nomes ou "nao". */
  | 'aguardando_nomes'
  /** Nomes recebidos; pergunta se algum e goleiro antes de cadastrar. */
  | 'aguardando_posicao_convidados'
  /** Um convidado foi apontado como goleiro; pergunta contratado ou convidado. */
  | 'aguardando_tipo_goleiro'
  /** Pediu para adicionar goleiro ("contratei um goleiro"); espera o nome. */
  | 'aguardando_nomes_goleiro'
  /** A pessoa saiu e tinha convidados; espera saber quais continuam indo. */
  | 'convidados_orfaos';

/** Um convidado apresentado ao jogador para escolha. */
export interface Candidato {
  readonly indice: number;
  readonly nome: string;
  readonly posicao: Posicao;
  /** Id da inscricao, quando o candidato veio de uma remocao a desfazer. */
  readonly inscricaoId?: number;
}

export interface DadosConversa {
  /** Convidados oferecidos para remocao, na ordem mostrada. */
  readonly candidatos?: readonly Candidato[];
  /**
   * Nomes de convidados ainda sem posicao definida (estado
   * 'aguardando_posicao_convidados').
   */
  readonly nomesPendentes?: readonly string[];
  /**
   * Fila de goleiros ja identificados, aguardando saber se sao contratados
   * ou convidados - um de cada vez (estado 'aguardando_tipo_goleiro').
   * O primeiro da fila e o que a pergunta atual se refere.
   */
  readonly filaGoleiros?: readonly string[];
  /**
   * Veio de "contratei um goleiro" (estado 'aguardando_nomes_goleiro'): o
   * verbo ja disse o tipo, entao ao receber o(s) nome(s) o bot cadastra direto
   * como contratado, sem perguntar "contratado ou convidado?" de novo.
   */
  readonly contratadoImplicito?: boolean;
  /**
   * O texto EXATO da pergunta que o bot mandou ao entrar neste estado. Guardado
   * para poder reprisar a mesma pergunta, sem reformular, quando o prazo esta
   * quase estourando (aviso proativo) ou quando a pessoa responde tarde demais
   * (ver `reiniciarPergunta` em handlers.ts).
   */
  readonly pergunta?: string;
  /**
   * true enquanto o bot espera "sim"/"nao" ao aviso de prazo quase estourando -
   * a proxima resposta da pessoa e sobre CONTINUAR, nao sobre a pergunta
   * original. Fica de fora da resposta normal do estado ate ser respondido.
   */
  readonly confirmandoExpiracao?: boolean;
}

export interface Conversa {
  readonly jogadorId: number;
  readonly partidaId: number;
  readonly estado: Estado;
  readonly dados: DadosConversa;
}

interface LinhaConversa {
  jogador_id: number;
  partida_id: number;
  estado: Estado;
  dados: DadosConversa;
}

/** Devolve a conversa ativa. Expirada conta como inexistente. */
export async function carregar(
  jogadorId: number,
): Promise<Conversa | undefined> {
  const r = await queryOne<LinhaConversa>(
    `select jogador_id, partida_id, estado, dados
       from conversa
      where jogador_id = $1 and expira_em > now()`,
    [jogadorId],
  );
  if (!r) return undefined;
  return {
    jogadorId: r.jogador_id,
    partidaId: r.partida_id,
    estado: r.estado,
    dados: r.dados ?? {},
  };
}

/**
 * Janela, apos a pergunta expirar, em que ainda vale a pena avisar "isso
 * caducou" em vez de um "nao entendi" seco - cobre quem demorou mais que o
 * TTL mas ainda assim respondeu no mesmo embalo (ver bug do Vinicius,
 * 27/08/2026). Passado isso, a resposta tardia e tratada como mensagem solta
 * de verdade, sem relacao presumida com uma pergunta antiga.
 */
const JANELA_EXPIRADA_RECENTE_MIN = 120;

/**
 * Conversa que ACABOU de expirar (dentro de `JANELA_EXPIRADA_RECENTE_MIN`).
 * Usada so para compor uma mensagem melhor que "nao entendi" quando a pessoa
 * responde tarde demais pro TTL, mas nao tarde o suficiente pra ser uma
 * mensagem solta sem contexto nenhum.
 */
export async function carregarExpiradaRecente(
  jogadorId: number,
): Promise<Conversa | undefined> {
  const r = await queryOne<LinhaConversa>(
    `select jogador_id, partida_id, estado, dados
       from conversa
      where jogador_id = $1
        and expira_em <= now()
        and expira_em > now() - ($2 || ' minutes')::interval`,
    [jogadorId, JANELA_EXPIRADA_RECENTE_MIN],
  );
  if (!r) return undefined;
  return {
    jogadorId: r.jogador_id,
    partidaId: r.partida_id,
    estado: r.estado,
    dados: r.dados ?? {},
  };
}

async function salvarComTTL(
  jogadorId: number,
  partidaId: number,
  estado: Estado,
  dados: DadosConversa,
  ttlMin: number,
): Promise<void> {
  await query(
    `insert into conversa (jogador_id, partida_id, estado, dados, expira_em)
     values ($1, $2, $3, $4::jsonb, now() + ($5 || ' minutes')::interval)
     on conflict (jogador_id) do update
       set partida_id = excluded.partida_id,
           estado     = excluded.estado,
           dados      = excluded.dados,
           expira_em  = excluded.expira_em`,
    [jogadorId, partidaId, estado, JSON.stringify(dados), ttlMin],
  );
}

export async function salvar(
  jogadorId: number,
  partidaId: number,
  estado: Estado,
  dados: DadosConversa,
): Promise<void> {
  await salvarComTTL(jogadorId, partidaId, estado, dados, config.CONVERSA_TTL_MIN);
}

/** Quanto antes do prazo o bot manda o aviso de "ainda ta ai?". */
const JANELA_AVISO_EXPIRACAO_MIN = 1;

/**
 * Tempo extra que a conversa ganha ao ser avisada - da uma folga de verdade
 * pra responder ao aviso, em vez de morrer no mesmo minuto em que ele chegou
 * (o cron que dispara o aviso roda a cada minuto, entao sem essa folga a
 * janela real de resposta podia ser de poucos segundos).
 */
const BUFFER_AVISO_MIN = 2;

/**
 * Conversas cujo prazo esta prestes a estourar e que ainda nao foram
 * avisadas. Usada pelo cron de `scheduler.ts` para mandar "ainda ta ai?"
 * antes de a pergunta expirar de verdade.
 */
export async function proximasAExpirar(): Promise<Conversa[]> {
  const r = await query<LinhaConversa>(
    `select jogador_id, partida_id, estado, dados
       from conversa
      where expira_em > now()
        and expira_em <= now() + ($1 || ' minutes')::interval
        and coalesce((dados->>'confirmandoExpiracao')::boolean, false) = false`,
    [JANELA_AVISO_EXPIRACAO_MIN],
  );
  return r.map((row) => ({
    jogadorId: row.jogador_id,
    partidaId: row.partida_id,
    estado: row.estado,
    dados: row.dados ?? {},
  }));
}

/**
 * Marca que o aviso de expiracao ja foi mandado e da a folga de
 * `BUFFER_AVISO_MIN` pra pessoa responder "sim" ou "nao".
 */
export async function marcarAvisoExpiracao(
  jogadorId: number,
  partidaId: number,
  estado: Estado,
  dados: DadosConversa,
): Promise<void> {
  await salvarComTTL(
    jogadorId,
    partidaId,
    estado,
    { ...dados, confirmandoExpiracao: true },
    BUFFER_AVISO_MIN,
  );
}

export async function limpar(jogadorId: number): Promise<void> {
  await query('delete from conversa where jogador_id = $1', [jogadorId]);
}

/**
 * Faxina periodica das conversas vencidas.
 *
 * NAO apaga assim que `expira_em` passa: `carregarExpiradaRecente` promete
 * `JANELA_EXPIRADA_RECENTE_MIN` (120min) de graca pra quem responde tarde, e
 * essa faxina roda de hora em hora - apagar no primeiro corte encolheria a
 * janela prometida pra as vezes 1 minuto, dependendo de quando dentro da hora
 * a conversa expirou. So apaga o que ja passou da propria janela de graca.
 */
export async function limparExpiradas(): Promise<number> {
  const r = await query<{ jogador_id: number }>(
    `delete from conversa
      where expira_em <= now() - ($1 || ' minutes')::interval
      returning jogador_id`,
    [JANELA_EXPIRADA_RECENTE_MIN],
  );
  return r.length;
}
