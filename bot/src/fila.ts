import { sendText } from './evolution/client.js';

/**
 * Fila de saida para mensagens que o BOT inicia (nao respostas).
 *
 * O motivo e concreto: quando o anuncio de quarta sai, dezenas de pessoas
 * reagem nos minutos seguintes. Mandar uma DM por reacao, na hora, produz um
 * pico de mensagens simultaneas para numeros que nao tem o bot salvo - que e
 * exatamente o padrao de disparo em massa que faz o WhatsApp derrubar a conta.
 *
 * Espacar resolve isso sem mudar nada para o usuario: a diferenca entre receber
 * a mensagem agora ou em vinte segundos e irrelevante para quem espera, e
 * decisiva para nao parecer robo de spam.
 *
 * Resposta a quem escreveu NAO passa por aqui: responder na hora e o esperado,
 * e nao caracteriza disparo.
 */

export interface Item {
  readonly para: string;
  readonly texto: string;
}

interface Log {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
}

const INTERVALO_MS = Number(process.env.FILA_INTERVALO_MS ?? '4000');

const pendentes: Item[] = [];
let rodando = false;

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function drenar(log: Log): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    while (pendentes.length) {
      const item = pendentes.shift();
      if (!item) break;
      await sendText(item.para, item.texto).catch((err) =>
        log.warn({ err, para: item.para }, 'falha ao enviar mensagem da fila'),
      );
      if (pendentes.length) await dormir(INTERVALO_MS);
    }
  } finally {
    rodando = false;
  }
}

/** Enfileira uma mensagem iniciada pelo bot. Volta na hora, envia depois. */
export function enfileirar(log: Log, item: Item): void {
  pendentes.push(item);
  log.info(
    { para: item.para, naFila: pendentes.length },
    'mensagem enfileirada',
  );
  void drenar(log);
}

/** Quantas mensagens ainda nao sairam. Util em teste e diagnostico. */
export function tamanhoDaFila(): number {
  return pendentes.length;
}
