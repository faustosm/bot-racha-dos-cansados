/**
 * Sincroniza convocados no app (rachadoscansados) quando a lista fecha (ver
 * scheduler.ts, `fecharLista`). So ADITIVO - liga convocado=true de quem
 * confirmou e casa por telefone, nunca desliga ninguem (ver merge.ts).
 *
 * Best-effort: nunca lanca pra fora. Uma falha aqui nao pode atrasar nem
 * derrubar o fechamento/anuncio da lista, que e o caminho critico do cron.
 */
import { config } from '../config.js';
import { listarFixosConfirmados, listarGoleirosConfirmados } from '../domain/inscricao.js';
import type { Partida } from '../domain/tipos.js';
import { sendText } from '../evolution/client.js';
import type { Log } from '../scheduler.js';
import { getRacha, putRacha, type AppRachaData } from './client.js';
import { aplicarConvocacoes, type ConfirmadoBot, type ResultadoMerge } from './merge.js';

const MAX_TENTATIVAS = 2; // leitura inicial + 1 retry em caso de 409

export async function sincronizarConvocadosNoApp(log: Log, partida: Partida): Promise<void> {
  if (!config.APP_SYNC_RACHA_ID || !config.APP_SYNC_EDIT_TOKEN) {
    log.warn({}, 'sincronizacao com o app desligada (falta APP_SYNC_RACHA_ID/APP_SYNC_EDIT_TOKEN)');
    return;
  }

  try {
    const [linha, gol] = await Promise.all([
      listarFixosConfirmados(partida.id),
      listarGoleirosConfirmados(partida.id),
    ]);
    const confirmados: ConfirmadoBot[] = [...linha, ...gol];
    if (confirmados.length === 0) {
      log.info({ partida: partida.data_jogo }, 'nenhum fixo confirmado, sincronizacao com o app pulada');
      return;
    }

    const resultado = await publicarComRetry(log, partida, confirmados, MAX_TENTATIVAS);
    if (resultado) await avisarComite(log, resultado);
  } catch (err) {
    log.warn({ err, partida: partida.data_jogo }, 'falha ao sincronizar convocados no app');
  }
}

async function publicarComRetry(
  log: Log,
  partida: Partida,
  confirmados: ConfirmadoBot[],
  tentativasRestantes: number,
): Promise<ResultadoMerge | null> {
  const leitura = await getRacha(config.APP_SYNC_URL, config.APP_SYNC_RACHA_ID, config.APP_SYNC_EDIT_TOKEN);
  const resultado = aplicarConvocacoes(leitura.data.players, confirmados);

  if (!resultado.mudou) {
    log.info({ partida: partida.data_jogo }, 'convocados no app ja estavam em dia, nada publicado');
    return resultado;
  }

  const novaData: AppRachaData = { ...leitura.data, players: resultado.players };
  const put = await putRacha(
    config.APP_SYNC_URL,
    config.APP_SYNC_RACHA_ID,
    config.APP_SYNC_EDIT_TOKEN,
    novaData,
    leitura.version,
  );

  if (put.ok) {
    log.info(
      {
        partida: partida.data_jogo,
        aplicados: resultado.aplicados.length,
        semCorrespondencia: resultado.semCorrespondencia.length,
      },
      'convocados sincronizados no app',
    );
    return resultado;
  }

  // 409: alguem publicou entre a leitura e a escrita. Um retry cobre o caso
  // comum (edicao alternada); mais que isso sugere edicao concorrente ativa
  // - desiste e deixa o fallback manual do dono cobrir esta semana.
  if (tentativasRestantes > 1) {
    log.info({ partida: partida.data_jogo }, '409 ao publicar convocados, tentando de novo');
    return publicarComRetry(log, partida, confirmados, tentativasRestantes - 1);
  }
  log.warn({ partida: partida.data_jogo }, 'conflito de versao persistiu, desisti desta rodada');
  return null;
}

async function avisarComite(log: Log, resultado: ResultadoMerge): Promise<void> {
  if (!config.GRUPO_ADMIN_JID) return;

  const linhas: string[] = [];
  if (resultado.semCorrespondencia.length) {
    linhas.push(
      '⚠️ Confirmei estas pessoas no bot mas não achei o telefone delas no app — não consegui marcar como convocado automaticamente:',
      '',
      ...resultado.semCorrespondencia.map((x) => `- ${x.nome}`),
      '',
      'Confere o telefone cadastrado no app ou marca manualmente.',
    );
  }

  if (resultado.possiveisSobras.length) {
    if (linhas.length) linhas.push('');
    linhas.push(
      '🔎 Estes continuam convocados no app mas não confirmaram esta semana — pode ser sobra de "limpar convocados" pendente:',
      '',
      ...resultado.possiveisSobras.map((x) => `- ${x.nome}`),
    );
  }

  if (!linhas.length) return;
  await sendText(config.GRUPO_ADMIN_JID, linhas.join('\n')).catch((err) =>
    log.warn({ err }, 'falha ao avisar o comite sobre convocados sem correspondencia'),
  );
}
