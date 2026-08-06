import pg from 'pg';
import { config } from './config.js';
import { migrations } from './migrations.js';

// O driver devolve DATE como string ("2026-08-08") em vez de Date. E o que
// queremos: data_jogo e um dia do calendario, nao um instante, e converter para
// Date reintroduziria fuso horario num lugar onde ele nao existe.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export type Row = Record<string, unknown>;

// Sem `T extends QueryResultRow`: exigir index signature obrigaria toda
// interface de linha a declarar `[k: string]: unknown`, o que enfraquece os
// tipos do dominio inteiro so para agradar o driver.
export async function query<T = Row>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await pool.query(text, params as unknown[]);
  return result.rows as T[];
}

/** Primeira linha, ou undefined. Evita `rows[0]` espalhado pelo codigo. */
export async function queryOne<T = Row>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(text, params);
  return rows[0];
}

/**
 * Roda `fn` dentro de uma transacao. Usado nas operacoes que checam vaga e
 * inserem: sem transacao, dois "vou" simultaneos passam pela mesma checagem e
 * a lista estoura o limite.
 */
export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Aplica as migrations pendentes. Idempotente: registra o que ja rodou em
 * schema_migrations e pula. Roda no boot, antes de o servidor aceitar trafego.
 */
export async function migrate(log: {
  info: (obj: unknown, msg: string) => void;
}): Promise<void> {
  await query(`
    create table if not exists schema_migrations (
      name       text primary key,
      aplicada_em timestamptz not null default now()
    )
  `);

  const aplicadas = new Set(
    (await query<{ name: string }>('select name from schema_migrations')).map(
      (r) => r.name,
    ),
  );

  for (const m of migrations) {
    if (aplicadas.has(m.name)) continue;
    await transaction(async (client) => {
      await client.query(m.sql);
      await client.query('insert into schema_migrations (name) values ($1)', [
        m.name,
      ]);
    });
    log.info({ migration: m.name }, 'migration aplicada');
  }
}
