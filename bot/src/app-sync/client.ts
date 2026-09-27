/**
 * Cliente da API de sincronizacao do app (rachadoscansados) - espelha
 * `src/lib/sync.js` daquele repo, so que em TS e so as duas rotas que o bot
 * usa (GET completo e PUT). Mesmo estilo de `github/client.ts`: fetch puro,
 * Authorization Bearer, timeout.
 */

export class AppSyncError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'AppSyncError';
  }
}

/**
 * O bot nao modela o schema inteiro do app (paid, amount, pendencias, etc.) -
 * so toca em `players[].convocado` e devolve todo o resto exatamente como
 * veio. O index signature evita que um campo novo do app quebre o bot.
 */
export interface AppPlayer {
  id: string;
  name?: string;
  phone?: string | null;
  category?: string;
  convocado?: boolean;
  [key: string]: unknown;
}

export interface AppRachaData {
  players: AppPlayer[];
  [key: string]: unknown;
}

interface RachaLido {
  version: number;
  updatedAt: number;
  data: AppRachaData;
}

export type PutResultado =
  | { ok: true; version: number; updatedAt: number }
  | { ok: false; conflict: true; version: number };

async function request(
  baseUrl: string,
  path: string,
  token: string,
  init: { method: string; body?: unknown } = { method: 'GET' },
): Promise<Response> {
  return fetch(`${baseUrl}/api/racha${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30_000),
  });
}

/** Dados completos do racha (qualquer papel). Lanca em qualquer erro que nao seja sucesso. */
export async function getRacha(
  baseUrl: string,
  id: string,
  token: string,
): Promise<RachaLido> {
  const resp = await request(baseUrl, `/${id}`, token);
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new AppSyncError(`GET racha respondeu ${resp.status}`, resp.status, body);
  }
  return (await resp.json()) as RachaLido;
}

/**
 * Publica. 409 (baseVersion divergente) e um resultado esperado, nao uma
 * excecao - quem chama decide se tenta de novo.
 */
export async function putRacha(
  baseUrl: string,
  id: string,
  token: string,
  data: AppRachaData,
  baseVersion: number,
): Promise<PutResultado> {
  const resp = await request(baseUrl, `/${id}`, token, {
    method: 'PUT',
    body: { data, baseVersion },
  });
  if (resp.status === 409) {
    const body = (await resp.json().catch(() => ({}))) as { version?: number };
    return { ok: false, conflict: true, version: body.version ?? baseVersion };
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new AppSyncError(`PUT racha respondeu ${resp.status}`, resp.status, body);
  }
  const body = (await resp.json()) as { version: number; updatedAt: number };
  return { ok: true, version: body.version, updatedAt: body.updatedAt };
}
