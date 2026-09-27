/**
 * Ferramenta de TESTE (nao roda em producao).
 *
 * Le os confirmados reais do Postgres e os dados reais do app (GET, que nao
 * muda nada) e imprime no terminal quem casaria por telefone, quem ficaria
 * sem correspondencia e quem pareceria sobra - sem NUNCA publicar (nao chama
 * `putRacha`). Serve pra conferir o casamento de telefones antes de confiar
 * na sincronizacao automatica de verdade.
 *
 * Precisa de APP_SYNC_RACHA_ID/APP_SYNC_EDIT_TOKEN configurados no .env.
 *
 * Uso, com a stack no ar:
 *   docker compose exec bot npx tsx src/dev/simular-sync-app.ts
 */
import { pool } from '../db.js';
import { config } from '../config.js';
import { listarFixosConfirmados, listarGoleirosConfirmados } from '../domain/inscricao.js';
import { partidaParaLeitura } from '../domain/partida.js';
import { getRacha } from '../app-sync/client.js';
import { aplicarConvocacoes, type ConfirmadoBot } from '../app-sync/merge.js';

async function main(): Promise<void> {
  if (!config.APP_SYNC_RACHA_ID || !config.APP_SYNC_EDIT_TOKEN) {
    console.error('APP_SYNC_RACHA_ID/APP_SYNC_EDIT_TOKEN vazios no .env - configura antes de simular.');
    process.exit(1);
  }

  const partida = await partidaParaLeitura();
  if (!partida) {
    console.error('nenhuma partida encontrada.');
    process.exit(1);
  }

  const [linha, gol] = await Promise.all([
    listarFixosConfirmados(partida.id),
    listarGoleirosConfirmados(partida.id),
  ]);
  const confirmados: ConfirmadoBot[] = [...linha, ...gol];
  console.log(`partida ${partida.data_jogo}: ${confirmados.length} fixo(s) confirmado(s) no bot`);

  const leitura = await getRacha(config.APP_SYNC_URL, config.APP_SYNC_RACHA_ID, config.APP_SYNC_EDIT_TOKEN);
  const resultado = aplicarConvocacoes(leitura.data.players, confirmados);

  console.log('\n--- SIMULACAO, nada foi publicado ---\n');
  console.log(`ja convocado ou seriam convocados agora (${resultado.correspondidos.length}):`);
  for (const c of resultado.correspondidos) {
    const novo = resultado.aplicados.some((a) => a.playerId === c.playerId);
    console.log(`  ${novo ? '+' : '='} ${c.nome}`);
  }

  console.log(`\nsem correspondencia no app (${resultado.semCorrespondencia.length}):`);
  for (const s of resultado.semCorrespondencia) console.log(`  ? ${s.nome}`);

  console.log(`\npossiveis sobras - convocado no app, nao confirmou (${resultado.possiveisSobras.length}):`);
  for (const s of resultado.possiveisSobras) console.log(`  ! ${s.nome}`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
