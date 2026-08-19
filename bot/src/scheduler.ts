import cron from 'node-cron';
import { config } from './config.js';
import { sendPoll, sendText } from './evolution/client.js';
import { listar, listarFixosConfirmados, listarGoleiros } from './domain/inscricao.js';
import {
  definirStatus,
  fecharVencidas,
  garantirPartida,
  marcarEncerrada,
  partidaAEncerrar,
  partidaAtual,
  partidaParaLeitura,
  registrarEnquete,
  reservarAbertura,
  reservarEncerramento,
} from './domain/partida.js';
import { OPCOES, tituloDaEnquete } from './domain/enquete.js';
import {
  OPCOES_AVALIACAO,
  criarConviteAvaliacao,
  tituloDaEnqueteAvaliacao,
} from './domain/avaliacao.js';
import { janelas, proximoSabado } from './domain/datas.js';
import {
  alertasDeVagas,
  contarVagas,
  formatarLista,
  rotuloData,
} from './domain/lista.js';
import { limparExpiradas } from './conversa.js';
import { ehMembro } from './grupo.js';
import { enfileirar } from './fila.js';

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
      `Lista aberta! ${partida.vagas_total} vagas de linha.`,
      `🧤 Goleiro (até ${partida.vagas_goleiro}) é convidado de quem já confirmou, ou contratado por fora — lista à parte.`,
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
    enquete_id?: string | null;
  },
): Promise<void> {
  if (!config.GROUP_JID) return;

  // Idempotencia: uma partida tem UMA enquete. Publicar de novo criaria uma
  // segunda no grupo e sobrescreveria o enquete_id - a primeira continuaria
  // visivel e pararia de funcionar em silencio, com os votos dela ignorados.
  if (partida.enquete_id) {
    log.info(
      { partida: partida.data_jogo, enqueteId: partida.enquete_id },
      'enquete ja publicada para esta partida, nao republico',
    );
    return;
  }

  const enquete = await sendPoll(
    config.GROUP_JID,
    tituloDaEnquete(partida.vagas_total),
    OPCOES,
  ).catch((err) => {
    log.warn({ err }, 'falha ao publicar a enquete');
    return undefined;
  });

  if (!enquete) {
    await anunciar(
      log,
      'Não consegui publicar a enquete desta semana. Me chame no privado para confirmar.',
    );
    return;
  }

  await registrarEnquete(partida.id, enquete);
  log.info({ enqueteId: enquete.id }, 'enquete publicada');
}

/** Quarta 12:00 — cria a partida do sabado e abre para os fixos. */
async function abrirParaFixos(log: Log): Promise<void> {
  const partida = await garantirPartida();

  // Mesma protecao da enquete: se a partida ja tem enquete, a abertura ja foi
  // anunciada. Repetir encheria o grupo com dois anuncios iguais.
  if (partida.enquete_id) {
    log.info(
      { partida: partida.data_jogo },
      'abertura ja anunciada para esta partida, nada a fazer',
    );
    return;
  }

  // Reserva atomica: cobre a corrida entre este cron e a faxina horaria de
  // recuperacao, que pode disparar no mesmo minuto (ver reservarAbertura).
  if (!(await reservarAbertura(partida.id))) {
    log.info(
      { partida: partida.data_jogo },
      'outra chamada ja esta abrindo esta partida, nao repito',
    );
    return;
  }

  log.info({ partida: partida.data_jogo }, 'lista aberta para fixos');
  await anunciarAberturaFixos(log, partida);
  await publicarEnquete(log, partida);
}

/** Quinta 12:00 — libera convidados. */
async function abrirParaConvidados(log: Log): Promise<void> {
  const partida = await partidaAtual();
  if (!partida) return;
  const [itens, goleiros] = await Promise.all([
    listar(partida.id),
    listarGoleiros(partida.id),
  ]);
  log.info({ partida: partida.data_jogo }, 'convidados liberados');
  await anunciar(
    log,
    [
      '👥 Convidados liberados!',
      'Quem já confirmou pode trazer alguém — é só marcar',
      '"Vou com convidado" na enquete que eu chamo no privado.',
      '',
      formatarLista(partida, itens, goleiros, config.RACHA_NOME),
    ].join('\n'),
  );
}

/**
 * Roda no horario de CRON_FECHA (sabado 07:00 por padrao, 2h antes do jogo)
 * — fecha a lista e publica a final.
 *
 * Usa `partidaParaLeitura`, nao `partidaAtual`: nesse horario o `fecha_em` ja
 * passou, e `partidaAtual` filtra por isso - com ela, a lista final nunca
 * seria publicada.
 */
async function fecharLista(log: Log): Promise<void> {
  const partida = await partidaParaLeitura();
  if (!partida) return;
  const [itens, goleiros] = await Promise.all([
    listar(partida.id),
    listarGoleiros(partida.id),
  ]);
  await definirStatus(partida.id, 'fechada');
  log.info({ partida: partida.data_jogo }, 'lista fechada');
  await anunciar(
    log,
    [
      '🏁 Lista fechada! Bola em jogo às ' + config.RACHA_HORARIO.split(' ')[0] + '.',
      '',
      formatarLista(partida, itens, goleiros, config.RACHA_NOME),
    ].join('\n'),
  );
}

/**
 * Quarta a sexta, 19:00 — o resumo do dia.
 *
 * E o coracao do modelo de notificacao: durante o dia o bot fica calado
 * enquanto o pessoal confirma, e uma vez por dia mostra como ficou. Sem isso, a
 * lista era republicada a cada confirmacao e o grupo virava mural de bot.
 */
export async function digestDoDia(log: Log): Promise<void> {
  const partida = await partidaAtual();
  if (!partida) return;

  const [itens, goleiros] = await Promise.all([
    listar(partida.id),
    listarGoleiros(partida.id),
  ]);
  const vagas = contarVagas(itens, partida.vagas_total);
  const alertas = alertasDeVagas(vagas, config.ALERTA_VAGAS);

  log.info({ ocupadas: vagas.ocupadas }, 'digest do dia');
  await anunciar(
    log,
    [
      `📋 Como está a lista para ${rotuloData(partida.data_jogo)}:`,
      '',
      formatarLista(partida, itens, goleiros, config.RACHA_NOME),
      ...(alertas.length ? ['', ...alertas] : []),
      '',
      'Para entrar ou sair, responda na enquete do racha 👆',
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
  const vagas = contarVagas(itens, partida.vagas_total);
  if (vagas.ocupadas >= config.MIN_JOGADORES) {
    log.info({ ocupadas: vagas.ocupadas }, 'time fechado, sem chamada de sexta');
    return;
  }

  const goleiros = await listarGoleiros(partida.id);
  const faltam = config.MIN_JOGADORES - vagas.ocupadas;
  log.info({ ocupadas: vagas.ocupadas }, 'chamada de sexta');
  await anunciar(
    log,
    [
      '📣 Amanhã tem racha e o time ainda não fechou!',
      `Temos ${vagas.ocupadas} na linha e o mínimo é ${config.MIN_JOGADORES} (6 de cada lado).`,
      `Faltam ${faltam} ${faltam === 1 ? 'jogador' : 'jogadores'}.`,
      '',
      'Quem ainda não respondeu, responde na enquete do racha 👆',
      '',
      formatarLista(partida, itens, goleiros, config.RACHA_NOME),
    ].join('\n'),
  );
}

/**
 * Anuncio PUBLICO de que a avaliacao vai rolar - so avisa, nao e a enquete
 * em si (essa vai individual, no privado, ver `enviarConvitesDeAvaliacao`).
 * Tom de brincadeira de proposito (texto do Fausto) - o resto do bot e seco,
 * mas essa e a unica mensagem pensada para arrancar risada do grupo.
 */
export function mensagemQualidade(): string {
  return [
    `⚽ DEPARTAMENTO DE QUALIDADE — ${config.RACHA_NOME}`,
    '',
    'O jogo de hoje foi encerrado com sucesso.',
    '',
    'Agora precisamos da avaliação dos jogadores que participaram. 📊',
    '',
    'Em alguns minutos, o bot enviará no privado uma avaliação para quem jogou hoje.',
    '',
    'Sua avaliação será utilizada para calcular o Índice de Qualidade do Racha e acompanhar a qualidade dos nossos jogos.',
    '',
    'O Departamento de Qualidade agradece sua colaboração. 😂⚽',
  ].join('\n');
}

/**
 * Manda o convite individual (enquete 0-5) para quem efetivamente jogou.
 *
 * "Efetivamente jogou" reusa a MESMA fonte de verdade da lista (fixo de
 * linha confirmado, `listarFixosConfirmados` em domain/inscricao.ts) - sem
 * segunda fonte paralela. Dois filtros a mais, por cima disso:
 *
 *  - `naoPerturbe`: convite tambem e mensagem que o bot INICIA, mesma regra
 *    de `puxarConversa`.
 *  - `ehMembro`: so manda para quem ainda esta no grupo agora. Isso e o que
 *    faz alguem que saiu do grupo entre a confirmacao e o fim do jogo (ex.:
 *    o caso do Ricardo/Ricarros Centro Automotivo em 15/08/2026) ficar de
 *    fora SOZINHO, sem precisar de nenhuma excecao ou lista negra no codigo
 *    - e so uma consequencia de nao estar mais no grupo.
 */
async function enviarConvitesDeAvaliacao(
  log: Log,
  partida: { id: number; data_jogo: string },
): Promise<void> {
  const fixos = await listarFixosConfirmados(partida.id);

  for (const fixo of fixos) {
    if (fixo.naoPerturbe) {
      log.info(
        { jogadorId: fixo.jogadorId },
        'nao_perturbe: convite de avaliacao nao enviado',
      );
      continue;
    }

    const membro = await ehMembro(log, {
      ...(fixo.lid ? { lid: fixo.lid } : {}),
      ...(fixo.telefone ? { telefone: fixo.telefone } : {}),
    });
    if (!membro) {
      log.info(
        { jogadorId: fixo.jogadorId },
        'nao e mais membro do grupo: convite de avaliacao nao enviado',
      );
      continue;
    }

    // Telefone, nao lid: e o formato que funciona para abrir um privado do
    // zero (lid so resolve dentro do contexto de um grupo compartilhado).
    if (!fixo.telefone) {
      log.warn(
        { jogadorId: fixo.jogadorId },
        'sem telefone cadastrado: nao da para mandar convite de avaliacao',
      );
      continue;
    }

    enfileirar(log, {
      tipo: 'enquete',
      para: fixo.telefone,
      titulo: tituloDaEnqueteAvaliacao(),
      opcoes: OPCOES_AVALIACAO,
      aoEnviar: async (enquete) => {
        if (!enquete) {
          log.warn(
            { jogadorId: fixo.jogadorId },
            'falha ao enviar convite de avaliacao',
          );
          return;
        }
        await criarConviteAvaliacao(partida.id, fixo.jogadorId, enquete);
        log.info(
          { jogadorId: fixo.jogadorId, enqueteId: enquete.id },
          'convite de avaliacao enviado',
        );
      },
    });
  }
}

/**
 * Sabado 12:00 (CRON_AVALIACAO) — o jogo ja acabou: avisa o grupo, manda os
 * convites individuais e marca a partida como encerrada.
 *
 * `partidaAEncerrar` filtra por `encerrada_em`, mas so grava esse campo DEPOIS
 * do anuncio e de mandar um convite por jogador - entao o cron de sabado e a
 * faxina horaria/de boot podem disparar quase juntos e as duas lerem
 * `encerrada_em` nulo. `reservarEncerramento` cobre exatamente essa corrida
 * (mesma ideia de `reservarAbertura` em `abrirParaFixos`): so quem ganha a
 * reserva segue em frente.
 */
async function encerrarPartida(log: Log): Promise<void> {
  const partida = await partidaAEncerrar();
  if (!partida) return;

  if (!(await reservarEncerramento(partida.id))) {
    log.info(
      { partida: partida.data_jogo },
      'outra chamada ja esta encerrando esta partida, nao repito',
    );
    return;
  }

  log.info({ partida: partida.data_jogo }, 'encerrando racha, avaliacao pos-jogo');
  await anunciar(log, mensagemQualidade());
  await enviarConvitesDeAvaliacao(log, partida);
  await marcarEncerrada(partida.id);
}

/**
 * Rede de seguranca: garante que a partida da semana exista.
 *
 * `garantirPartida` so era chamado no cron de quarta 12:00. Se o container
 * estivesse parado naquele minuto - deploy, reboot, queda - a semana inteira
 * morria em silencio: nenhuma enquete, digest calado, e quem tentasse
 * confirmar ouvia "nenhum racha aberto". Sem recuperacao ate a quarta seguinte.
 *
 * Roda de hora em hora e so age depois que a janela de abertura ja passou. Se a
 * abertura ja tiver sido anunciada, `abrirParaFixos` nao faz nada - a guarda de
 * idempotencia da enquete cobre isso.
 */
async function recuperarAberturaPerdida(log: Log): Promise<void> {
  const dataJogo = proximoSabado(new Date());
  const { abreFixos, fechaEm } = janelas(dataJogo);
  const agora = new Date();
  if (agora < abreFixos) return; // ainda nao era para ter aberto

  // Container fora do ar por mais de uma semana, so voltando ja em cima do
  // proximo sabado: a janela de inscricao deste jogo ja fechou, entao abrir
  // (e anunciar "Lista aberta!") agora so confundiria o grupo com um jogo que
  // nao aceita mais confirmacao.
  if (agora >= fechaEm) return;

  const partida = await partidaAtual();
  if (partida?.enquete_id) return; // ja abriu, tudo certo

  log.warn(
    { dataJogo },
    'abertura da semana nao aconteceu no horario - recuperando agora',
  );
  await abrirParaFixos(log);
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
    ['digest', config.CRON_DIGEST, () => digestDoDia(log)],
    ['chamada', config.CRON_CHAMADA, () => chamadaDeSexta(log)],
    ['avaliacao', config.CRON_AVALIACAO, () => encerrarPartida(log)],
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
    recuperarAberturaPerdida(log).catch((err) =>
      log.warn({ err }, 'falha ao recuperar abertura perdida'),
    );
    encerrarPartida(log).catch((err) =>
      log.warn({ err }, 'falha ao encerrar partida/publicar avaliacao'),
    );
  });

  // E no boot, para nao esperar ate a proxima hora cheia depois de um deploy.
  // E justamente no boot que a recuperacao mais importa: se o container passou
  // a quarta ao meio-dia fora do ar, ele volta e conserta sozinho.
  fecharVencidas()
    .then((n) => {
      if (n > 0) log.info({ partidas: n }, 'partidas vencidas fechadas no boot');
      return recuperarAberturaPerdida(log);
    })
    .then(() => encerrarPartida(log))
    .catch((err) => log.warn({ err }, 'falha na faxina de boot'));
}
