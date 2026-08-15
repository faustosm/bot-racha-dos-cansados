import { query, queryOne } from '../db.js';

// Enquete de avaliacao pos-jogo ("Departamento de Qualidade"). Mesmo contrato
// criptografico da enquete de confirmacao (ver domain/voto.ts): o texto de
// cada opcao entra no hash do voto, entao nao muda depois de publicada.
// Emojis numericos sem descricao de proposito (pedido do Fausto - enquete
// simples, sem "pessimo"/"bom"/etc.).
export const OPCOES_AVALIACAO: readonly string[] = [
  '0️⃣',
  '1️⃣',
  '2️⃣',
  '3️⃣',
  '4️⃣',
  '5️⃣',
];

/** A opcao votada, traduzida para a nota (0-5). */
export function interpretarNota(opcao: string): number | undefined {
  const indice = OPCOES_AVALIACAO.indexOf(opcao);
  return indice === -1 ? undefined : indice;
}

export function tituloDaEnqueteAvaliacao(): string {
  return '⚽ Qual nota você dá para o racha de hoje?';
}

// Campos em snake_case, espelhando a coluna - mesmo estilo de `Partida` em
// tipos.ts, sem mapper: e um tipo pequeno, so para uso interno do dominio.
export interface ConviteAvaliacao {
  readonly id: number;
  readonly partida_id: number;
  readonly jogador_id: number;
  readonly enquete_segredo: string;
}

/**
 * Registra o envio de UM convite individual (uma enquete por pessoa, ver
 * migration 013) - nota comeca nula, so preenche quando o voto chegar.
 *
 * `on conflict` cobre o reenvio da recuperacao horaria: se `encerrarPartida`
 * rodar de novo antes do convite anterior ter sido votado, atualiza o par
 * id/segredo em vez de tentar duplicar a linha (unique por partida+jogador).
 */
export async function criarConviteAvaliacao(
  partidaId: number,
  jogadorId: number,
  enquete: { id: string; segredoBase64: string; criadorJid?: string | undefined },
): Promise<void> {
  await query(
    `insert into avaliacao (partida_id, jogador_id, enquete_id, enquete_segredo, enquete_criador)
     values ($1, $2, $3, $4, $5)
     on conflict (partida_id, jogador_id) do update
       set enquete_id      = excluded.enquete_id,
           enquete_segredo = excluded.enquete_segredo,
           enquete_criador = excluded.enquete_criador`,
    [partidaId, jogadorId, enquete.id, enquete.segredoBase64, enquete.criadorJid ?? null],
  );
}

/** O convite dono de um enquete_id, para casar o voto que chegou. */
export async function conviteAvaliacaoPorEnquete(
  enqueteId: string,
): Promise<ConviteAvaliacao | undefined> {
  return queryOne<ConviteAvaliacao>(
    `select id, partida_id, jogador_id, enquete_segredo
       from avaliacao
      where enquete_id = $1
        and enquete_segredo is not null`,
    [enqueteId],
  );
}

/**
 * Grava a nota de um convite ja existente. Trocar o voto na enquete
 * atualiza em vez de duplicar - o convite (e o unique de origem) ja garante
 * uma nota so por pessoa por partida.
 */
export async function registrarAvaliacao(
  conviteId: number,
  nota: number,
): Promise<void> {
  await query(
    'update avaliacao set nota = $2, criado_em = now() where id = $1',
    [conviteId, nota],
  );
}
