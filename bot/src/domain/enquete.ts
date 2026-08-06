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
 * Nao ha opcao de goleiro na enquete de proposito: goleiro no racha e quase
 * sempre convidado de fora, e o fluxo de convidado ja pergunta linha ou gol
 * para cada um. Fixo que queira ir no gol manda "vou de gol" no privado.
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
 * Curto de proposito - o endereco completo vai no anuncio logo acima, que nao
 * tem limite de tamanho nem risco de corte na lista de conversas.
 */
export function tituloDaEnquete(id: {
  nome: string;
  local: string;
  rotuloData: string;
  horario: string;
}): string {
  const onde = id.local ? ` · ${id.local}` : '';
  return `⚽ ${id.nome}${onde} — ${id.rotuloData}, ${id.horario}`;
}

// --------------------------------------------------------------------------
// Ultimo voto de cada pessoa
// --------------------------------------------------------------------------

/**
 * Registra a opcao votada e devolve a anterior.
 *
 * O bot decide o que anunciar comparando OPCAO com OPCAO, nao o estado da
 * lista: trocar "Vou" por "Vou com convidado" nao muda a vaga, mas muda o
 * recado - e o grupo precisa ver.
 */
export async function registrarVoto(
  partidaId: number,
  jogadorId: number,
  opcao: string,
): Promise<string | undefined> {
  const anterior = await queryOne<{ opcao: string }>(
    'select opcao from voto where partida_id = $1 and jogador_id = $2',
    [partidaId, jogadorId],
  );

  await query(
    `insert into voto (partida_id, jogador_id, opcao) values ($1, $2, $3)
     on conflict (partida_id, jogador_id) do update
       set opcao = excluded.opcao, atualizado_em = now()`,
    [partidaId, jogadorId, opcao],
  );

  return anterior?.opcao;
}
