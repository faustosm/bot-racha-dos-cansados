import { sendPoll, sendText } from './evolution/client.js';
import type { EnquetePublicada } from './evolution/client.js';

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
 * decisiva para nao parecer robo de spam. Mesmo raciocinio vale para os
 * convites individuais da avaliacao pos-jogo (um por jogador, todos de uma vez).
 *
 * Resposta a quem escreveu NAO passa por aqui: responder na hora e o esperado,
 * e nao caracteriza disparo.
 */

interface ItemTexto {
  readonly tipo: 'texto';
  readonly para: string;
  readonly texto: string;
}

interface ItemEnquete {
  readonly tipo: 'enquete';
  readonly para: string;
  readonly titulo: string;
  readonly opcoes: readonly string[];
  /** Roda depois do envio (sucesso ou falha) - e onde quem chamou persiste o convite. */
  readonly aoEnviar: (enquete: EnquetePublicada | undefined) => Promise<void> | void;
}

export type Item = ItemTexto | ItemEnquete;

interface Log {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
}

const INTERVALO_MS = Number(process.env.FILA_INTERVALO_MS ?? '4000');

const pendentes: Item[] = [];
let rodando = false;

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function enviar(log: Log, item: Item): Promise<void> {
  if (item.tipo === 'texto') {
    await sendText(item.para, item.texto).catch((err) =>
      log.warn({ err, para: item.para }, 'falha ao enviar mensagem da fila'),
    );
    return;
  }

  const enquete = await sendPoll(item.para, item.titulo, item.opcoes).catch(
    (err) => {
      log.warn({ err, para: item.para }, 'falha ao enviar enquete da fila');
      return undefined;
    },
  );
  await item.aoEnviar(enquete);
}

async function drenar(log: Log): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    while (pendentes.length) {
      const item = pendentes.shift();
      if (!item) break;
      await enviar(log, item);
      if (pendentes.length) await dormir(INTERVALO_MS);
    }
  } finally {
    rodando = false;
  }
}

/** Enfileira uma mensagem/enquete iniciada pelo bot. Volta na hora, envia depois. */
export function enfileirar(log: Log, item: Item): void {
  pendentes.push(item);
  log.info(
    { para: item.para, tipo: item.tipo, naFila: pendentes.length },
    'mensagem enfileirada',
  );
  void drenar(log);
}

/** Quantas mensagens ainda nao sairam. Util em teste e diagnostico. */
export function tamanhoDaFila(): number {
  return pendentes.length;
}
