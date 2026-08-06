import { config } from '../config.js';

class EvolutionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'EvolutionError';
  }
}

async function request<T>(
  path: string,
  init: { method: string; body?: unknown },
): Promise<T> {
  const url = `${config.EVOLUTION_URL}${path}`;

  const response = await fetch(url, {
    method: init.method,
    headers: {
      'Content-Type': 'application/json',
      apikey: config.EVOLUTION_API_KEY,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new EvolutionError(
      `${init.method} ${path} respondeu ${response.status}`,
      response.status,
      body,
    );
  }

  return (await response.json()) as T;
}

/** Envia uma mensagem de texto para um JID (contato ou grupo). */
export function sendText(to: string, text: string, quotedId?: string) {
  return request(`/message/sendText/${config.EVOLUTION_INSTANCE}`, {
    method: 'POST',
    body: {
      number: to,
      text,
      ...(quotedId ? { quoted: { key: { id: quotedId } } } : {}),
    },
  });
}

/** Reage a uma mensagem com um emoji. Util para confirmar sem poluir o grupo. */
export function sendReaction(
  to: string,
  messageId: string,
  fromMe: boolean,
  emoji: string,
) {
  return request(`/message/sendReaction/${config.EVOLUTION_INSTANCE}`, {
    method: 'POST',
    body: {
      key: { remoteJid: to, id: messageId, fromMe },
      reaction: emoji,
    },
  });
}

interface RespostaEnquete {
  key?: { id?: string; participant?: string };
  message?: {
    messageContextInfo?: { messageSecret?: Record<string, number> };
  };
}

export interface EnquetePublicada {
  readonly id: string;
  /** `messageSecret` em base64 - sem ele nao ha como decifrar voto nenhum. */
  readonly segredoBase64: string;
  /**
   * JID (@lid) do bot como criador.
   *
   * A resposta da CRIACAO nao traz esse campo - ele so aparece no voto, em
   * `pollCreationMessageKey.participant`. Fica opcional aqui e a decriptacao
   * usa o valor que vem junto com o voto.
   */
  readonly criadorJid?: string | undefined;
}

/**
 * Publica uma enquete. O `messageSecret` da resposta e a UNICA chance de
 * guardar a chave dos votos: ele nao aparece em mais lugar nenhum depois.
 */
export async function sendPoll(
  to: string,
  nome: string,
  opcoes: readonly string[],
): Promise<EnquetePublicada | undefined> {
  const r = await request<RespostaEnquete>(
    `/message/sendPoll/${config.EVOLUTION_INSTANCE}`,
    {
      method: 'POST',
      body: { number: to, name: nome, selectableCount: 1, values: opcoes },
    },
  );

  const id = r.key?.id;
  const segredo = r.message?.messageContextInfo?.messageSecret;
  if (!id || !segredo) return undefined;

  // A Evolution serializa o segredo como objeto {"0":161,"1":225,...}.
  const bytes = Object.keys(segredo)
    .map(Number)
    .sort((a, b) => a - b)
    .map((k) => segredo[k] ?? 0);

  return {
    id,
    segredoBase64: Buffer.from(bytes).toString('base64'),
    ...(r.key?.participant ? { criadorJid: r.key.participant } : {}),
  };
}

/** Estado da conexao: "open" | "connecting" | "close". */
export function connectionState() {
  return request<{ instance: { state: string } }>(
    `/instance/connectionState/${config.EVOLUTION_INSTANCE}`,
    { method: 'GET' },
  );
}
