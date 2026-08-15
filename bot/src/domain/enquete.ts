import { query, queryOne } from '../db.js';
import type { Posicao } from './tipos.js';

// As opcoes da enquete e o que cada uma significa.
//
// O TEXTO AQUI E CONTRATO CRIPTOGRAFICO, nao rotulo. O voto identifica a opcao
// pelo SHA-256 do texto exato, emoji incluso - mudar uma letra, um acento ou um
// emoji faz o bot deixar de reconhecer os votos das enquetes ja publicadas.
//
// Se precisar mudar o texto, mude junto com a publicacao de uma enquete nova.
// Enquete ja no ar continua valendo pelo texto antigo.

export const OPCAO_VOU = '✅ Vou';
export const OPCAO_VOU_COM_CONVIDADO = '👥 Vou com convidado';
export const OPCAO_NAO_VOU = '❌ Não vou';

export const OPCOES: readonly string[] = [
  OPCAO_VOU,
  OPCAO_VOU_COM_CONVIDADO,
  OPCAO_NAO_VOU,
];

export type AcaoDoVoto =
  | { readonly tipo: 'confirmar'; readonly posicao: Posicao }
  | { readonly tipo: 'confirmar_com_convidado' }
  | { readonly tipo: 'desistir' };

/**
 * Traduz a opcao votada em acao de dominio.
 *
 * Nao ha opcao de goleiro na enquete de proposito: quem confirma pela enquete
 * e sempre um jogador de LINHA. Goleiro (contratado ou convidado de um fixo)
 * tem lista propria e entra por outro caminho - ver domain/inscricao.ts e o
 * dialogo de convidados em handlers.ts.
 */
export function interpretar(opcao: string): AcaoDoVoto | undefined {
  switch (opcao) {
    case OPCAO_VOU:
      return { tipo: 'confirmar', posicao: 'linha' };
    case OPCAO_VOU_COM_CONVIDADO:
      return { tipo: 'confirmar_com_convidado' };
    case OPCAO_NAO_VOU:
      return { tipo: 'desistir' };
    default:
      return undefined;
  }
}

/**
 * Titulo da enquete publicada no grupo.
 *
 * Ao contrario do texto das OPCOES, o titulo nao entra no hash do voto: mudar
 * aqui e seguro e nao quebra enquete nenhuma.
 *
 * Curto de proposito - nome, data, local e endereco ja saem no anuncio logo
 * acima. Repetir tudo aqui so faz a enquete ficar comprida sem ajudar; o que
 * importa neste titulo e o convite pro voto e quantas vagas de linha tem.
 */
export function tituloDaEnquete(vagas: number): string {
  return `⚽ Vote aí! ${vagas} vagas de linha`;
}

// --------------------------------------------------------------------------
// Ultimo voto de cada pessoa
// --------------------------------------------------------------------------

/**
 * A ultima opcao votada por essa pessoa nesta partida.
 *
 * O bot decide o que anunciar comparando OPCAO com OPCAO, nao o estado da
 * lista: trocar "Vou" por "Vou com convidado" nao muda a vaga, mas muda o
 * recado - e o grupo precisa ver.
 */
export async function votoAnterior(
  partidaId: number,
  jogadorId: number,
): Promise<string | undefined> {
  const r = await queryOne<{ opcao: string }>(
    'select opcao from voto where partida_id = $1 and jogador_id = $2',
    [partidaId, jogadorId],
  );
  return r?.opcao;
}

/**
 * Registra a opcao votada.
 *
 * Separado da leitura de proposito: so deve ser chamado DEPOIS de a acao ter
 * sucesso. Registrar uma tentativa que falhou (lista cheia, por exemplo) faz a
 * proxima tentativa identica ser silenciada pelo dedupe, e a pessoa nunca
 * entra quando a vaga abre.
 */
export async function registrarVoto(
  partidaId: number,
  jogadorId: number,
  opcao: string,
): Promise<void> {
  await query(
    `insert into voto (partida_id, jogador_id, opcao) values ($1, $2, $3)
     on conflict (partida_id, jogador_id) do update
       set opcao = excluded.opcao, atualizado_em = now()`,
    [partidaId, jogadorId, opcao],
  );
}
