import { config } from '../config.js';

class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'GithubError';
  }
}

async function request(
  path: string,
  init: { method: string; body?: unknown },
): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${config.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30_000),
  });
}

function rota(path: string): string {
  const caminhoCodificado = path.split('/').map(encodeURIComponent).join('/');
  return `/repos/${config.GITHUB_REPO}/contents/${caminhoCodificado}`;
}

export interface ArquivoAtual {
  sha: string;
  conteudo: string;
}

interface ConteudoBruto {
  sha: string;
  content: string;
}

/** Le um arquivo do repo. `undefined` se ele ainda nao existir. */
export async function lerArquivo(path: string): Promise<ArquivoAtual | undefined> {
  const resp = await request(rota(path), { method: 'GET' });
  if (resp.status === 404) return undefined;
  if (resp.status !== 200) {
    const body = await resp.text().catch(() => '');
    throw new GithubError(`GET contents respondeu ${resp.status}`, resp.status, body);
  }
  const bruto = (await resp.json()) as ConteudoBruto;
  return { sha: bruto.sha, conteudo: Buffer.from(bruto.content, 'base64').toString('utf8') };
}

/**
 * Escreve `conteudo` em `path` (cria ou atualiza). `sha` e o da leitura
 * anterior - obrigatorio pra atualizar um arquivo existente, ignorado se ele
 * ainda nao existe.
 */
export async function escreverArquivo(
  path: string,
  conteudo: string,
  mensagem: string,
  sha: string | undefined,
): Promise<void> {
  const resp = await request(rota(path), {
    method: 'PUT',
    body: {
      message: mensagem,
      content: Buffer.from(conteudo, 'utf8').toString('base64'),
      ...(sha ? { sha } : {}),
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new GithubError(`PUT contents respondeu ${resp.status}`, resp.status, body);
  }
}
