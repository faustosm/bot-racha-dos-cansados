/**
 * Decide quais jogadores do app devem virar convocado=true, a partir de quem
 * confirmou no bot. Pura e testavel sem rede/Postgres - toda a parte de I/O
 * fica em sincronizar.ts.
 *
 * Regra central, a garantia da politica aditiva: esta funcao NUNCA produz
 * convocado=false para ninguem. So liga, nunca desliga - ver o `## Contexto`
 * do plano de implementacao para a justificativa (um modo replace arriscaria
 * apagar convocacao manual legitima que o bot nao tem como conhecer).
 */
import { normalizarTelefone } from './telefone.js';
import type { AppPlayer } from './client.js';

export interface ConfirmadoBot {
  readonly jogadorId: number;
  readonly nome: string;
  readonly telefone: string | null;
}

interface Correspondencia {
  readonly jogadorId: number;
  readonly nome: string;
  readonly playerId: string;
}

export interface ResultadoMerge {
  /** Novo array; mesma referencia que a entrada se nada mudou. */
  readonly players: AppPlayer[];
  readonly mudou: boolean;
  /** So quem passou de convocado=false/ausente para true. */
  readonly aplicados: Correspondencia[];
  /** Todo mundo que casou por telefone, aplicado ou ja convocado antes. */
  readonly correspondidos: Correspondencia[];
  readonly semCorrespondencia: { jogadorId: number; nome: string }[];
  /**
   * So aviso, nunca acao: fixo que continua convocado=true no app mas nao
   * confirmou nesta semana (provavel sobra de "esqueceu de limpar
   * convocados"). Restrito a category='fixo' - goleiro_pago/goleiro_isento
   * tendem a ser mais permanentes/manuais, e entrariam aqui toda semana.
   */
  readonly possiveisSobras: { playerId: string; nome: string }[];
}

/** Mapa telefone-normalizado -> player, removendo colisoes (nao adivinha qual e o certo). */
function mapaPorTelefone(players: AppPlayer[]): Map<string, AppPlayer> {
  const mapa = new Map<string, AppPlayer>();
  const colisoes = new Set<string>();
  for (const player of players) {
    const tel = normalizarTelefone(player.phone);
    if (!tel) continue;
    if (mapa.has(tel)) {
      colisoes.add(tel);
      continue;
    }
    mapa.set(tel, player);
  }
  for (const tel of colisoes) mapa.delete(tel);
  return mapa;
}

export function aplicarConvocacoes(
  players: AppPlayer[],
  confirmados: ConfirmadoBot[],
): ResultadoMerge {
  const porTelefone = mapaPorTelefone(players);
  const aplicados: Correspondencia[] = [];
  const correspondidos: Correspondencia[] = [];
  const semCorrespondencia: { jogadorId: number; nome: string }[] = [];
  const idsParaLigar = new Set<string>();

  for (const confirmado of confirmados) {
    const tel = normalizarTelefone(confirmado.telefone);
    const player = tel ? porTelefone.get(tel) : undefined;
    if (!player) {
      semCorrespondencia.push({ jogadorId: confirmado.jogadorId, nome: confirmado.nome });
      continue;
    }
    const correspondencia: Correspondencia = {
      jogadorId: confirmado.jogadorId,
      nome: confirmado.nome,
      playerId: player.id,
    };
    correspondidos.push(correspondencia);
    if (player.convocado !== true) {
      idsParaLigar.add(player.id);
      aplicados.push(correspondencia);
    }
  }

  const idsCorrespondidos = new Set(correspondidos.map((c) => c.playerId));
  const possiveisSobras = players
    .filter((p) => p.category === 'fixo' && p.convocado === true && !idsCorrespondidos.has(p.id))
    .map((p) => ({ playerId: p.id, nome: p.name ?? p.id }));

  if (idsParaLigar.size === 0) {
    return { players, mudou: false, aplicados, correspondidos, semCorrespondencia, possiveisSobras };
  }

  const novosPlayers = players.map((p) =>
    idsParaLigar.has(p.id) ? { ...p, convocado: true } : p,
  );
  return {
    players: novosPlayers,
    mudou: true,
    aplicados,
    correspondidos,
    semCorrespondencia,
    possiveisSobras,
  };
}
