import cron from 'node-cron';
import { config } from './config.js';
import { sendPoll, sendText } from './evolution/client.js';
import { listar } from './domain/inscricao.js';
import {
  definirStatus,
  fecharVencidas,
  garantirPartida,
  marcarEncerrada,
  partidaAEncerrar,
  partidaAtual,
  partidaParaLeitura,
  registrarEnquete,
} from './domain/partida.js';
import { OPCOES, tituloDaEnquete } from './domain/enquete.js';
import { contarVagas, formatarLista, rotuloData } from './domain/lista.js';
import { limparExpiradas } from './conversa.js';

export interface Log {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
}

// Os cron rodam no horario local do processo. Os containers usam
// TZ=America/Sao_Paulo (docker-compose.yml), entao "0 12 * * 3" e quarta ao
// meio-dia de Brasilia sem nenhuma conversao.

export async function anunciar(log: Log, texto: string): Promise<void> {
  if (!config.GROUP_JID) {
    log.warn({}, 'GROUP_JID vazio: anuncio nao enviado');
    return;
  }
  await sendText(config.GROUP_JID, texto).catch((err) =>
    log.warn({ err }, 'falha ao anunciar no grupo'),
  );
}

/**
 * O anuncio de abertura, separado da criacao da partida para poder ser
 * disparado sozinho (ver src/dev/simular-abertura.ts).
 */
export async function anunciarAberturaFixos(
  log: Log,
  partida: { data_jogo: string; vagas_total: number; vagas_goleiro: number },
): Promise<void> {
  await anunciar(
    log,
    [
      `⚽ ${config.RACHA_NOME}${config.RACHA_LOCAL ? ` — ${config.RACHA_LOCAL}` : ''}`,
      `📅 ${rotuloData(partida.data_jogo)}, ${config.RACHA_HORARIO}`,
      ...(config.RACHA_ENDERECO ? [`📍 ${config.RACHA_ENDERECO}`] : []),
      '',
      `Lista aberta! ${partida.vagas_total} vagas (ate ${partida.vagas_goleiro} de gol).`,
      '',
      'Responda na enquete abaixo 👇',
    ].join('\n'),
  );
}

/**
 * Publica a enquete e guarda o que permite decifrar os votos.
 *
 * Se o segredo nao vier, nao adianta deixar a enquete no ar: voto nenhum seria
 * legivel e o grupo ficaria clicando no vazio. Melhor avisar e cair para o
 * caminho por texto.
 */
export async function publicarEnquete(
  log: Log,
  partida: {
    id: number;
    data_jogo: string;
    vagas_total: number;
    vagas_goleiro: number;
  },
): Promise<void> {
  if (!config.GROUP_JID) return;

  const enquete = await sendPoll(
    config.GROUP_JID,
    tituloDaEnquete({
      nome: config.RACHA_NOME,
      local: config.RACHA_LOCAL,
      rotuloData: rotuloData(partida.data_jogo),
      horario: config.RACHA_HORARIO,
    }),
    OPCOES,
  ).catch((err) => {
    log.warn({ err }, 'falha ao publicar a enquete');
    return undefined;
  });

  if (!enquete) {
    await anunciar(
      log,
      'Nao consegui publicar a enquete desta semana. Confirme no meu privado.',
    );
    return;
  }

  await registrarEnquete(partida.id, enquete);
  log.info({ enqueteId: enquete.id }, 'enquete publicada');
}

/** Quarta 12:00 — cria a partida do sabado e abre para os fixos. */
async function abrirParaFixos(log: Log): Promise<void> {
  const partida = await garantirPartida();
  log.info({ partida: partida.data_jogo }, 'lista aberta para fixos');
  await anunciarAberturaFixos(log, partida);
  await publicarEnquete(log, partida);
}

/** Quinta 12:00 — libera convidados. */
async function abrirParaConvidados(log: Log): Promise<void> {
  const partida = await partidaAtual();
  if (!partida) return;
  const itens = await listar(partida.id);
  log.info({ partida: partida.data_jogo }, 'convidados liberados');
  await anunciar(
    log,
    [
      '👥 Convidados liberados!',
      'Quem ja confirmou pode trazer alguem.',
      '',
      formatarLista(partida, itens, config.RACHA_NOME),
    ].join('\n'),
  );
}

/**
 * Sabado 09:00 — fecha a lista e publica a final.
 *
 * Usa `partidaParaLeitura`, nao `partidaAtual`: as 09:00 em ponto o `fecha_em`
 * ja passou, e `partidaAtual` filtra por isso - com ela, a lista final nunca
 * seria publicada.
 */
async function fecharLista(log: Log): Promise<void> {
  const partida = await partidaParaLeitura();
  if (!partida) return;
  const itens = await listar(partida.id);
  await definirStatus(partida.id, 'fechada');
  log.info({ partida: partida.data_jogo }, 'lista fechada');
  await anunciar(
    log,
    [
      '🏁 Lista fechada, bola em jogo!',
      '',
      formatarLista(partida, itens, config.RACHA_NOME),
    ].join('\n'),
  );
}

/**
 * Sexta 08:00 — chamada geral quando o time nao fecha.
 *
 * So fala se estiver faltando gente: anunciar "esta tudo certo" toda sexta
 * seria ruido semanal sem informacao.
 */
async function chamadaDeSexta(log: Log): Promise<void> {
  const partida = await partidaAtual();
  if (!partida) return;

  const itens = await listar(partida.id);
  const vagas = contarVagas(itens, partida.vagas_total, partida.vagas_goleiro);
  const faltaGente = vagas.ocupadas < config.MIN_JOGADORES;
  const faltaGoleiro = vagas.gol.ocupadas < config.MIN_GOLEIROS;
  if (!faltaGente && !faltaGoleiro) {
    log.info({ ocupadas: vagas.ocupadas }, 'time fechado, sem chamada de sexta');
    return;
  }

  const pedidos: string[] = [];
  if (faltaGente) {
    pedidos.push(
      `Faltam ${config.MIN_JOGADORES - vagas.ocupadas} para o minimo de ${config.MIN_JOGADORES}.`,
    );
  }
  if (faltaGoleiro) {
    pedidos.push(
      vagas.gol.ocupadas === 0
        ? 'Nao temos NENHUM goleiro ainda 🧤'
        : `Falta ${config.MIN_GOLEIROS - vagas.gol.ocupadas} goleiro 🧤`,
    );
  }

  log.info({ ocupadas: vagas.ocupadas, gol: vagas.gol.ocupadas }, 'chamada de sexta');
  await anunciar(
    log,
    [
      '📣 Amanha tem racha e o time ainda nao fechou!',
      ...pedidos,
      '',
      'Quem ainda nao respondeu, responde na enquete la em cima 👆',
      '',
      formatarLista(partida, itens, config.RACHA_NOME),
    ].join('\n'),
  );
}

/**
 * Sabado 12:00 — o jogo acabou. Encerra a semana e avisa que a enquete daquela
 * semana morreu, para ninguem votar nela achando que vale para a proxima.
 */
async function encerrarSemana(log: Log): Promise<void> {
  const partida = await partidaAEncerrar();
  if (!partida) return;

  await marcarEncerrada(partida.id);
  log.info({ partida: partida.data_jogo }, 'semana encerrada');
  await anunciar(
    log,
    [
      `🔚 ${config.RACHA_NOME} de ${rotuloData(partida.data_jogo)} encerrado. Ate semana que vem!`,
      '',
      'A enquete acima nao vale mais — na quarta eu publico a nova.',
    ].join('\n'),
  );
}

export function iniciarAgendador(log: Log): void {
  const tarefas: [string, string, () => Promise<void>][] = [
    ['abre_fixos', config.CRON_ABRE_FIXOS, () => abrirParaFixos(log)],
    [
      'abre_convidados',
      config.CRON_ABRE_CONVIDADOS,
      () => abrirParaConvidados(log),
    ],
    ['fecha', config.CRON_FECHA, () => fecharLista(log)],
    ['chamada', config.CRON_CHAMADA, () => chamadaDeSexta(log)],
    ['encerra', config.CRON_ENCERRA, () => encerrarSemana(log)],
  ];

  for (const [nome, expressao, fn] of tarefas) {
    if (!cron.validate(expressao)) {
      log.warn({ nome, expressao }, 'cron invalido, tarefa nao agendada');
      continue;
    }
    cron.schedule(expressao, () => {
      fn().catch((err) => log.warn({ err, nome }, 'falha na tarefa agendada'));
    });
    log.info({ nome, expressao }, 'tarefa agendada');
  }

  // Faxina de hora em hora: conversas vencidas e, principalmente, partidas que
  // passaram da hora sem o cron de sabado ter rodado (container parado naquele
  // minuto). Sem isso a partida velha sombreia todas as seguintes.
  cron.schedule('0 * * * *', () => {
    limparExpiradas().catch((err) =>
      log.warn({ err }, 'falha ao limpar conversas expiradas'),
    );
    fecharVencidas().catch((err) =>
      log.warn({ err }, 'falha ao fechar partidas vencidas'),
    );
  });

  // E no boot, para nao esperar ate a proxima hora cheia depois de um deploy.
  fecharVencidas()
    .then((n) => {
      if (n > 0) log.info({ partidas: n }, 'partidas vencidas fechadas no boot');
    })
    .catch((err) => log.warn({ err }, 'falha ao fechar partidas no boot'));
}
