/**
 * Ferramenta de TESTE (nao roda em producao).
 *
 * Dispara o mesmo resumo diario do cron de qua/qui/sex 19:00, na hora, contra
 * a partida atual - sem esperar o horario. Usa `digestDoDia` de verdade: o que
 * sai aqui e o que sairia la.
 *
 * Uso, com a stack no ar e uma partida ja aberta (ex: apos simular-abertura.ts):
 *   docker compose exec bot npx tsx src/dev/simular-digest.ts
 */
import { pool } from '../db.js';
import { digestDoDia } from '../scheduler.js';

const log = {
  info: (obj: unknown, msg: string) => console.log(msg, obj),
  warn: (obj: unknown, msg: string) => console.warn(msg, obj),
};

digestDoDia(log)
  .then(() => {
    console.log('digest enviado para o grupo');
    return pool.end();
  })
  .catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
