/**
 * Ferramenta de TESTE (nao roda em producao).
 *
 * Calcula as estatisticas a partir do Postgres e imprime o JSON no terminal
 * - sem publicar nada no GitHub - pra conferir os numeros antes de commitar
 * GITHUB_TOKEN de verdade no .env.
 *
 * Uso:
 *   docker compose exec bot npx tsx src/dev/simular-estatisticas.ts
 */
import { pool } from '../db.js';
import { calcularEstatisticas } from '../domain/estatisticas.js';

calcularEstatisticas()
  .then((estatisticas) => {
    console.log(JSON.stringify(estatisticas, null, 2));
    return pool.end();
  })
  .catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
