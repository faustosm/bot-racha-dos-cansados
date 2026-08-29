import { config } from './config.js';
import { calcularEstatisticas, type Estatisticas } from './domain/estatisticas.js';
import { escreverArquivo, lerArquivo } from './github/client.js';
import type { Log } from './scheduler.js';

/** Tudo menos `geradoEm` - e o timestamp que faria toda rodada "mudar",
 * mesmo em semana sem racha novo, e gerar um commit (e build no Cloudflare)
 * por nada. */
function semTimestamp(estatisticas: Estatisticas): Omit<Estatisticas, 'geradoEm'> {
  const { geradoEm: _geradoEm, ...resto } = estatisticas;
  return resto;
}

/**
 * Recalcula o boletim publico e publica no repo do site
 * (rachadoscansados.com.br/estatistica) - so commita se os NUMEROS mudaram
 * (compara ignorando `geradoEm`). O site continua 100% estatico, sem API
 * viva pro Postgres: o bot empurra o JSON via git.
 */
export async function publicarEstatisticas(log: Log): Promise<void> {
  if (!config.GITHUB_TOKEN) {
    log.warn({}, 'GITHUB_TOKEN vazio - publicacao de estatisticas desligada');
    return;
  }

  const estatisticas = await calcularEstatisticas();
  const atual = await lerArquivo(config.GITHUB_ESTATISTICAS_PATH);

  if (atual) {
    try {
      const atualParseado = JSON.parse(atual.conteudo) as Estatisticas;
      if (
        JSON.stringify(semTimestamp(atualParseado)) ===
        JSON.stringify(semTimestamp(estatisticas))
      ) {
        log.info({ rachas: estatisticas.totalRachas }, 'estatisticas sem mudanca - nada publicado');
        return;
      }
    } catch {
      // Arquivo remoto corrompido/formato antigo: trata como "mudou" e
      // sobrescreve com o calculo atual.
    }
  }

  const conteudo = `${JSON.stringify(estatisticas, null, 2)}\n`;
  await escreverArquivo(
    config.GITHUB_ESTATISTICAS_PATH,
    conteudo,
    'Atualiza estatisticas do racha',
    atual?.sha,
  );
  log.info({ rachas: estatisticas.totalRachas }, 'estatisticas publicadas');
}
