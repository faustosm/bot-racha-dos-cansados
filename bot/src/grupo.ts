import { config } from './config.js';
import { fetchGroupParticipants } from './evolution/client.js';

/**
 * Quem e membro do grupo do racha.
 *
 * O bot so interage com essas pessoas. O motivo e concreto: o numero dele nao e
 * uma linha dedicada, entao gente de fora escreve para ele achando que fala com
 * o dono - e uma dessas pessoas quase recebeu um manual de racha como resposta
 * a uma conversa pessoal.
 *
 * Ser do grupo e o criterio certo porque e o mesmo criterio do racha: quem nao
 * esta la nao joga, entao nao tem o que conversar com o bot.
 */

interface Log {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
}

const TTL_MS = Number(process.env.GRUPO_CACHE_MS ?? String(10 * 60_000));

interface Cache {
  readonly ids: ReadonlySet<string>;
  /** O proprio LID do bot, achado na mesma lista (ver `meuLid`). */
  readonly meuLid: string | undefined;
  readonly em: number;
}

let cache: Cache | undefined;

/** Descarta o cache. Chamado quando alguem entra ou sai do grupo. */
export function invalidarCache(): void {
  cache = undefined;
}

async function carregar(log: Log): Promise<Cache | undefined> {
  if (!config.GROUP_JID) return undefined;

  const participantes = await fetchGroupParticipants(config.GROUP_JID).catch(
    (err) => {
      log.warn({ err }, 'falha ao consultar os membros do grupo');
      return undefined;
    },
  );
  if (!participantes) return undefined;

  const ids = new Set<string>();
  let meuLid: string | undefined;
  const botTelefone = config.BOT_NUMERO ? `${config.BOT_NUMERO}@s.whatsapp.net` : undefined;
  for (const p of participantes) {
    if (p.lid) ids.add(p.lid);
    if (p.telefone) ids.add(p.telefone);
    if (botTelefone && p.telefone === botTelefone) meuLid = p.lid;
  }

  log.info({ membros: participantes.length }, 'lista de membros atualizada');
  return { ids, meuLid, em: Date.now() };
}

/**
 * Essa pessoa e membro do grupo?
 *
 * Casa por qualquer um dos dois identificadores, porque cada canal entrega um:
 * no grupo chega o @lid, no privado chega o telefone.
 *
 * FALHA FECHADA: se a consulta falhar e nao houver cache, devolve `false` - o
 * bot fica calado. Responder a todos quando a API falha reabriria exatamente o
 * problema que esta regra fecha, e falha de API costuma acontecer quando
 * ninguem esta olhando.
 */
export async function ehMembro(
  log: Log,
  identidade: { lid?: string | undefined; telefone?: string | undefined },
): Promise<boolean> {
  const valido = cache && Date.now() - cache.em < TTL_MS;
  if (!valido) cache = (await carregar(log)) ?? cache;

  if (!cache) {
    log.warn({}, 'sem lista de membros: nao respondo por precaucao');
    return false;
  }

  return (
    (identidade.lid !== undefined && cache.ids.has(identidade.lid)) ||
    (identidade.telefone !== undefined && cache.ids.has(identidade.telefone))
  );
}

/**
 * O LID do proprio bot - achado na lista de participantes do grupo (mesmo
 * `config.BOT_NUMERO`, so que no formato @lid). E o mesmo LID em qualquer
 * conversa (grupo ou privado): a Evolution nao expoe isso em nenhum campo do
 * webhook de enquete privada, entao esse e o unico jeito de descobrir.
 *
 * Necessario para decifrar voto de avaliacao (enquete individual no
 * privado): a receita valida empiricamente e criador=LID / votante=LID, e o
 * LID do criador (o bot) nao vem em `pollCreationMessageKey` fora de grupo.
 */
export async function meuLid(log: Log): Promise<string | undefined> {
  const valido = cache && Date.now() - cache.em < TTL_MS;
  if (!valido) cache = (await carregar(log)) ?? cache;
  return cache?.meuLid;
}
