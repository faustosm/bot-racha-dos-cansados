import Fastify from 'fastify';
import { config, isGroupConfigured } from './config.js';
import { migrate, pool } from './db.js';
import { tratarMensagem, tratarVoto } from './handlers.js';
import { iniciarAgendador } from './scheduler.js';

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    transport:
      config.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } }
        : undefined,
  },
});

// --------------------------------------------------------------------------
// Tipos minimos do payload da Evolution API. So o que usamos - o payload real
// e bem maior e varia por tipo de mensagem.
// --------------------------------------------------------------------------
interface WebhookBody {
  event?: string;
  instance?: string;
  data?: {
    key?: {
      remoteJid?: string;
      fromMe?: boolean;
      id?: string;
      // Em grupo: autor da mensagem. Com addressingMode "lid" vem como @lid e
      // o telefone correspondente chega em participantAlt.
      participant?: string;
      participantAlt?: string;
      // No privado o par equivalente: um dos dois e @lid, o outro e telefone.
      remoteJidAlt?: string;
    };
    pushName?: string;
    message?: {
      conversation?: string;
      extendedTextMessage?: { text?: string };
      // Voto de enquete. Vem CIFRADO: a Evolution nao decifra em grupo com LID.
      pollUpdateMessage?: {
        pollCreationMessageKey?: { id?: string; participant?: string };
        vote?: {
          encPayload?: Record<string, number>;
          encIv?: Record<string, number>;
        };
      };
    };
    // connection.update
    state?: string;
  };
}

/**
 * A Evolution reentrega com backoff ate 10 vezes se o webhook demorar. Nos
 * respondemos 200 na hora, entao a reentrega e rara - mas quando acontece o
 * mesmo "Joao" entraria duas vezes na lista.
 *
 * Em memoria de proposito: a janela de reentrega e de segundos, e um restart
 * limpar o cache nao tem consequencia pratica.
 */
const JANELA_DEDUPE_MS = 5 * 60_000;
const vistos = new Map<string, number>();

function jaProcessada(id: string | undefined): boolean {
  if (!id) return false;
  const agora = Date.now();
  for (const [chave, quando] of vistos) {
    if (agora - quando > JANELA_DEDUPE_MS) vistos.delete(chave);
  }
  if (vistos.has(id)) return true;
  vistos.set(id, agora);
  return false;
}

/** A Evolution serializa bytes como {"0":12,"1":34,...}. */
function paraBytes(obj: Record<string, number> | undefined): Uint8Array {
  if (!obj) return new Uint8Array();
  const chaves = Object.keys(obj)
    .map(Number)
    .sort((a, b) => a - b);
  return Uint8Array.from(chaves.map((k) => obj[String(k)] ?? 0));
}

function extractText(data: NonNullable<WebhookBody['data']>): string {
  const msg = data.message;
  if (!msg) return '';
  return msg.conversation ?? msg.extendedTextMessage?.text ?? '';
}

// --------------------------------------------------------------------------
// Handlers de evento
// --------------------------------------------------------------------------
async function handleMessagesUpsert(data: NonNullable<WebhookBody['data']>) {
  const key = data.key;
  const remoteJid = key?.remoteJid;

  // Sem isso o bot responde as proprias mensagens e entra em loop.
  if (key?.fromMe) return;
  if (!remoteJid) return;

  const isGroup = remoteJid.endsWith('@g.us');

  // Voto de enquete chega como mensagem sem texto, antes de qualquer parser.
  const votoDeEnquete = data.message?.pollUpdateMessage;
  if (votoDeEnquete) {
    await tratarVoto({
      enqueteId: votoDeEnquete.pollCreationMessageKey?.id,
      criadorJid: votoDeEnquete.pollCreationMessageKey?.participant,
      votanteLid: key?.participant,
      votanteTelefone: key?.participantAlt,
      nome: data.pushName,
      encPayload: paraBytes(votoDeEnquete.vote?.encPayload),
      encIv: paraBytes(votoDeEnquete.vote?.encIv),
      log: app.log,
    });
    return;
  }

  const text = extractText(data).trim();
  if (!text) return;

  if (jaProcessada(key?.id)) {
    app.log.info({ id: key?.id }, 'mensagem repetida (reentrega), ignorando');
    return;
  }

  // No primeiro boot o GROUP_JID ainda esta vazio. Logamos o JID de qualquer
  // grupo que mande mensagem para voce copiar para o .env.
  if (isGroup && !isGroupConfigured) {
    app.log.info(
      { groupJid: remoteJid, pushName: data.pushName },
      'GROUP_JID nao configurado. Copie este groupJid para o .env e rode "make restart".',
    );
    return;
  }

  if (isGroup && remoteJid !== config.GROUP_JID) {
    app.log.debug({ remoteJid }, 'mensagem de outro grupo, ignorando');
    return;
  }

  // A MESMA pessoa chega com identificadores diferentes conforme o canal:
  //   grupo   -> participant = @lid,     participantAlt = telefone
  //   privado -> remoteJid   = telefone, remoteJidAlt   = @lid
  // Passamos os dois adiante para o bot juntar num unico jogador.
  const [principal, alternativo] = isGroup
    ? [key?.participant, key?.participantAlt]
    : [remoteJid, key?.remoteJidAlt];

  const ehLid = (v?: string) => v?.endsWith('@lid') ?? false;
  const lid = ehLid(principal) ? principal : ehLid(alternativo) ? alternativo : undefined;
  const telefone = ehLid(principal) ? alternativo : principal;

  if (!lid && !telefone) {
    app.log.warn({ remoteJid }, 'mensagem sem autor identificavel, ignorando');
    return;
  }

  // Para responder no privado usamos o JID que a propria Evolution entregou:
  // e o endereco que sabemos que funciona de volta.
  const jidPrivado = (isGroup ? (telefone ?? lid) : remoteJid) as string;

  app.log.info(
    { remoteJid, lid, telefone, pushName: data.pushName, text },
    'mensagem recebida',
  );

  await tratarMensagem({
    ...(lid ? { lid } : {}),
    ...(telefone ? { telefone } : {}),
    jidPrivado,
    nome: data.pushName ?? telefone ?? lid ?? 'desconhecido',
    texto: text,
    origem: isGroup ? 'grupo' : 'privado',
    ...(key?.id ? { messageId: key.id } : {}),
    log: app.log,
  });
}

function handleConnectionUpdate(data: NonNullable<WebhookBody['data']>) {
  const state = data.state;
  if (state === 'open') {
    app.log.info({ state }, 'sessao do WhatsApp conectada');
    return;
  }
  // Alerta: sessao caiu. Pode ser o celular do bot offline, linha desativada
  // ou a regra dos 14 dias sem o aparelho principal se conectar.
  app.log.warn(
    { state },
    'sessao do WhatsApp NAO esta conectada - verifique o celular do bot; pode ser necessario reler o QR ("make qr")',
  );
}

async function handleEvent(body: WebhookBody) {
  const event = body.event;
  const data = body.data;
  if (!data) return;

  switch (event) {
    case 'messages.upsert':
      await handleMessagesUpsert(data);
      break;
    case 'connection.update':
      handleConnectionUpdate(data);
      break;
    case 'group.participants.update':
      app.log.info({ data }, 'participantes do grupo mudaram');
      break;
    case 'messages.update':
      // Nao usamos: o voto util chega em messages.upsert. Aqui vem so recibo
      // de entrega e leitura.
      break;
    default:
      app.log.debug({ event }, 'evento nao tratado');
  }
}

// --------------------------------------------------------------------------
// Rotas
// --------------------------------------------------------------------------
app.get('/health', async () => ({ status: 'ok' }));

app.post('/webhook/evolution', async (request, reply) => {
  const token = request.headers['x-webhook-token'];
  if (token !== config.WEBHOOK_TOKEN) {
    app.log.warn({ ip: request.ip }, 'webhook com token invalido');
    return reply.code(401).send({ error: 'unauthorized' });
  }

  // Responder 200 IMEDIATAMENTE, antes de processar. A Evolution reentrega com
  // backoff exponencial ate 10 vezes se demorarmos - o que geraria mensagens
  // duplicadas no grupo.
  void reply.code(200).send({ received: true });

  const body = request.body as WebhookBody;
  setImmediate(() => {
    handleEvent(body).catch((err) => {
      app.log.error({ err, event: body?.event }, 'falha ao processar evento');
    });
  });

  return reply;
});

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------
async function main() {
  if (!isGroupConfigured) {
    app.log.warn(
      'GROUP_JID vazio: o bot vai apenas logar o JID dos grupos que receberem mensagem.',
    );
  }

  // Antes de aceitar trafego: um webhook chegando com tabela faltando viraria
  // erro no meio do grupo.
  await migrate(app.log);
  iniciarAgendador(app.log);

  await app.listen({ port: config.BOT_PORT, host: '0.0.0.0' });
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'encerrando');
    app.close().then(
      async () => {
        await pool.end().catch(() => {});
        process.exit(0);
      },
      () => process.exit(1),
    );
  });
}

main().catch((err) => {
  app.log.error({ err }, 'falha ao subir o servidor');
  process.exit(1);
});
