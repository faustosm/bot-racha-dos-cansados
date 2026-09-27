/**
 * Roda agora a atualizacao de fotos de perfil no app, sem esperar o
 * CRON_FOTOS de segunda. PUBLICA no app de verdade (so o campo `photo`).
 *
 * Uso, com a stack no ar:
 *   docker compose exec bot npx tsx src/dev/atualizar-fotos.ts
 */
import { pool } from '../db.js';
import { atualizarFotosNoApp } from '../app-sync/fotos.js';

const log = { info: console.log, warn: console.warn };
await atualizarFotosNoApp(log);
await pool.end();
