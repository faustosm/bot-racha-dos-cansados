export type Posicao = 'linha' | 'gol';
export type TipoInscricao = 'fixo' | 'convidado';
export type StatusPartida = 'aberta' | 'cheia' | 'fechada';

export interface Partida {
  readonly id: number;
  /** Dia do calendario, "YYYY-MM-DD". Nao e instante: nao tem fuso. */
  readonly data_jogo: string;
  readonly abre_fixos: Date;
  readonly abre_convidados: Date;
  readonly fecha_em: Date;
  readonly vagas_total: number;
  readonly vagas_goleiro: number;
  readonly status: StatusPartida;
  /** Id da mensagem da enquete publicada no grupo. */
  readonly enquete_id: string | null;
  /** `messageSecret` da enquete, em base64. Necessario para decifrar votos. */
  readonly enquete_segredo: string | null;
  /** JID (@lid) de quem criou a enquete - o proprio bot. */
  readonly enquete_criador: string | null;
  /** Quando o encerramento foi anunciado no grupo. Null = ainda nao foi. */
  readonly encerrada_em: Date | null;
  /** Sabado 12:00 - quando a avaliacao pos-jogo dispara. Null em linhas antigas. */
  readonly encerra_em: Date | null;
  /** Reserva atomica da abertura, ver reservarAbertura em partida.ts. */
  readonly abrindo_em: Date | null;
  /** Reserva atomica do encerramento, ver reservarEncerramento em partida.ts. */
  readonly encerrando_em: Date | null;
}

/** Uma vaga ocupada, ja com o nome resolvido para exibicao. */
export interface ItemLista {
  readonly id: number;
  readonly nome: string;
  readonly tipo: TipoInscricao;
  readonly posicao: Posicao;
  /** Id do jogador. Presente apenas quando tipo === 'fixo'. */
  readonly jogadorId?: number;
  /** Nome de quem trouxe. Presente apenas quando tipo === 'convidado'. */
  readonly convidadoDe?: string;
  /** Id de quem trouxe, para a remocao saber de quem e o convidado. */
  readonly convidadoDeId?: number;
}

/**
 * Um goleiro confirmado. Lista PROPRIA, separada da linha - nunca ocupa vaga
 * dos 18 (ver VAGAS_GOLEIRO, teto proprio).
 */
export interface ItemGoleiro {
  readonly id: number;
  readonly nome: string;
  /** Contratado por fora (sem anfitriao) vs convidado de um fixo. */
  readonly contratado: boolean;
  /** Nome de quem trouxe. Ausente quando contratado. */
  readonly convidadoDe?: string;
  readonly convidadoDeId?: number;
}

/**
 * Resultado de uma operacao de dominio. Recusa por regra de negocio ("lista
 * cheia") nao e excecao: e uma resposta esperada que vira mensagem no grupo.
 * Excecao fica para o que realmente quebrou (banco fora do ar).
 */
export type Resultado<T> =
  | { readonly ok: true; readonly valor: T }
  | { readonly ok: false; readonly motivo: string };

export const ok = <T>(valor: T): Resultado<T> => ({ ok: true, valor });
export const erro = <T = never>(motivo: string): Resultado<T> => ({
  ok: false,
  motivo,
});
