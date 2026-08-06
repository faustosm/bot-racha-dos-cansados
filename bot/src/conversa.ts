import { query, queryOne } from './db.js';
import { config } from './config.js';
import type { Posicao } from './domain/tipos.js';

// Estado do dialogo no privado. Fica no banco, nao em memoria: o container
// reinicia (deploy, hot reload) e a pessoa nao pode ficar com uma pergunta
// pendurada que o bot nao sabe mais responder.

export type Estado =
  /** Perguntou se vai levar convidados; espera nomes ou "nao". */
  | 'aguardando_nomes'
  /** Perguntou se o convidado da vez e de linha ou gol. */
  | 'aguardando_posicao'
  /** Mostrou os convidados numerados; espera quais tirar. */
  | 'aguardando_remocao'
  /** Pediu confirmacao de uma remocao especifica; espera sim/nao. */
  | 'confirmando_remocao'
  /** Perguntou se o nome do WhatsApp esta certo; espera sim/nao. */
  | 'confirmando_nome'
  /** A pessoa disse que o nome esta errado; espera o nome certo. */
  | 'aguardando_nome'
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
  /** Nomes ainda nao registrados, na ordem em que foram informados. */
  readonly pendentes?: readonly string[];
  /** Nomes ja registrados nesta rodada, para a mensagem final. */
  readonly registrados?: readonly { nome: string; posicao: Posicao }[];
  /** Convidados oferecidos para remocao, na ordem mostrada. */
  readonly candidatos?: readonly Candidato[];
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

export async function salvar(
  jogadorId: number,
  partidaId: number,
  estado: Estado,
  dados: DadosConversa,
): Promise<void> {
  await query(
    `insert into conversa (jogador_id, partida_id, estado, dados, expira_em)
     values ($1, $2, $3, $4::jsonb, now() + ($5 || ' minutes')::interval)
     on conflict (jogador_id) do update
       set partida_id = excluded.partida_id,
           estado     = excluded.estado,
           dados      = excluded.dados,
           expira_em  = excluded.expira_em`,
    [jogadorId, partidaId, estado, JSON.stringify(dados), config.CONVERSA_TTL_MIN],
  );
}

export async function limpar(jogadorId: number): Promise<void> {
  await query('delete from conversa where jogador_id = $1', [jogadorId]);
}

/** Faxina periodica das conversas vencidas. */
export async function limparExpiradas(): Promise<number> {
  const r = await query<{ jogador_id: number }>(
    'delete from conversa where expira_em <= now() returning jogador_id',
  );
  return r.length;
}
