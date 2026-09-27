/**
 * Fotos de perfil do WhatsApp no app (rachadoscansados), ao lado do nome.
 *
 * Grava a MINIATURA (96x96, ~2 KB) como data URL direto em `players[].photo`:
 * o app nao tem onde guardar arquivo, so o JSON sincronizado, que tem teto de
 * ~1 MB (worker/lib.js). 50 miniaturas dao ~120 KB; a foto grande estouraria.
 *
 * O link que o WhatsApp devolve expira em dias, por isso a copia dos bytes e
 * nao o link. Roda toda semana (CRON_FOTOS) pra pegar quem trocou de foto.
 *
 * Best-effort: nunca lanca pra fora.
 */
import { config } from '../config.js';
import { query } from '../db.js';
import { fotoDePerfilMiniatura } from '../evolution/client.js';
import { getRacha, putRacha } from './client.js';
import { normalizarTelefone } from './telefone.js';
import { aplicarFotos, jidDoJogador } from './fotos-merge.js';

interface Log {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
}

/** Miniatura maior que isso nao e miniatura - melhor nao guardar. */
const MAX_BYTES = 15_000;
/** Espaco entre consultas ao WhatsApp: sao dezenas seguidas. */
const INTERVALO_MS = Number(process.env.FOTOS_INTERVALO_MS ?? '1500');
const MAX_TENTATIVAS = 2;

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function atualizarFotosNoApp(log: Log): Promise<void> {
  if (!config.APP_SYNC_RACHA_ID || !config.APP_SYNC_EDIT_TOKEN) {
    log.info({}, 'fotos no app: sincronizacao com o app desligada');
    return;
  }
  try {
    await atualizar(log);
  } catch (err) {
    log.warn({ err }, 'falha ao atualizar fotos no app');
  }
}

async function atualizar(log: Log): Promise<void> {
  const telefones = await query<{ telefone: string }>(
    `select telefone from jogador where telefone like '%@s.whatsapp.net'`,
  );
  const telefonesDoBot = new Map<string, string>();
  for (const t of telefones) {
    const chave = normalizarTelefone(t.telefone);
    if (chave) telefonesDoBot.set(chave, t.telefone);
  }

  const inicial = await getRacha(config.APP_SYNC_URL, config.APP_SYNC_RACHA_ID, config.APP_SYNC_EDIT_TOKEN);
  const mudancas = new Map<string, string | null>();
  let comFoto = 0;
  let semFoto = 0;
  let erros = 0;

  for (const p of inicial.data.players) {
    const jid = jidDoJogador(p.phone, telefonesDoBot);
    if (!jid) continue;

    const r = await fotoDePerfilMiniatura(jid);
    if (r.tipo === 'foto' && r.bytes.length <= MAX_BYTES) {
      mudancas.set(p.id, `data:${r.mime};base64,${Buffer.from(r.bytes).toString('base64')}`);
      comFoto++;
    } else if (r.tipo === 'semFoto') {
      mudancas.set(p.id, null);
      semFoto++;
    } else {
      // Erro passageiro ou foto grande demais: nao mexe na foto que ja existe.
      erros++;
    }
    await dormir(INTERVALO_MS);
  }

  // A varredura leva minutos: publica sobre uma leitura NOVA, pra nao
  // desfazer o que alguem editou no app nesse meio tempo.
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    const leitura = await getRacha(config.APP_SYNC_URL, config.APP_SYNC_RACHA_ID, config.APP_SYNC_EDIT_TOKEN);
    const { players, alterados } = aplicarFotos(leitura.data.players, mudancas);
    if (alterados === 0) {
      log.info({ comFoto, semFoto, erros }, 'fotos no app ja estavam em dia');
      return;
    }
    const put = await putRacha(
      config.APP_SYNC_URL,
      config.APP_SYNC_RACHA_ID,
      config.APP_SYNC_EDIT_TOKEN,
      { ...leitura.data, players },
      leitura.version,
    );
    if (put.ok) {
      log.info({ comFoto, semFoto, erros, alterados }, 'fotos atualizadas no app');
      return;
    }
  }
  log.warn({}, 'fotos no app: conflito de versao persistiu, fica pra proxima');
}
