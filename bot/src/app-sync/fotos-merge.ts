/**
 * Parte pura de fotos.ts (sem banco, sem rede, sem config) - testavel sozinha.
 */
import type { AppPlayer } from './client.js';
import { normalizarTelefone } from './telefone.js';

/** playerId -> nova foto (data URL), ou null pra tirar a foto. */
export type MudancasDeFoto = ReadonlyMap<string, string | null>;

/**
 * Aplica as mudancas na lista de jogadores mais recente. Pura: e chamada de
 * novo a cada retry, sobre a leitura nova. Jogador que sumiu do app no meio
 * do caminho e ignorado.
 */
export function aplicarFotos(
  players: readonly AppPlayer[],
  mudancas: MudancasDeFoto,
): { players: AppPlayer[]; alterados: number } {
  let alterados = 0;
  const novos = players.map((p) => {
    if (!mudancas.has(p.id)) return p;
    const foto = mudancas.get(p.id) ?? null;
    if ((p.photo ?? null) === foto) return p;
    alterados++;
    if (foto === null) {
      const { photo: _fora, ...sem } = p;
      return sem as AppPlayer;
    }
    return { ...p, photo: foto };
  });
  return { players: novos, alterados };
}

/**
 * JID de WhatsApp de um jogador do app. Prefere o telefone que o bot ja viu
 * (formato exato que o WhatsApp usa, com ou sem o 9); senao monta a partir do
 * que foi digitado no app.
 */
export function jidDoJogador(
  phone: string | null | undefined,
  telefonesDoBot: ReadonlyMap<string, string>,
): string | undefined {
  const chave = normalizarTelefone(phone);
  if (!chave) return undefined;
  const doBot = telefonesDoBot.get(chave);
  if (doBot) return doBot;
  const digitos = (phone ?? '').replace(/\D/g, '');
  const comDdi = digitos.length === 10 || digitos.length === 11 ? `55${digitos}` : digitos;
  return /^55\d{10,11}$/.test(comDdi) ? `${comDdi}@s.whatsapp.net` : undefined;
}
