import cron from 'node-cron';
import { config } from './config.js';
import { fetchGroupParticipants, sendPoll, sendText } from './evolution/client.js';
import {
  listar,
  listarFixosConfirmados,
  listarGoleiros,
  promoverPendentes,
} from './domain/inscricao.js';
import {
  definirStatus,
  fecharVencidas,
  garantirPartida,
  listaAberta,
  marcarEncerrada,
  partidaAEncerrar,
  partidaAtual,
  partidaParaLeitura,
  registrarEnquete,
  reservarAbertura,
  reservarEncerramento,
} from './domain/partida.js';
import { OPCOES, explicacaoDaReserva, tituloDaEnquete } from './domain/enquete.js';
import * as reserva from './domain/reserva.js';
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
  mensagemSubiuDaReserva,
  rotuloData,
} from './domain/lista.js';
import { limparExpiradas, marcarAvisoExpiracao, proximasAExpirar } from './conversa.js';
import { buscarPorId, buscarPorTelefone } from './domain/jogador.js';
import { ehMembro } from './grupo.js';
import { enfileirar } from './fila.js';
import { publicarEstatisticas } from './estatisticas.js';

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
      explicacaoDaReserva(),
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

  // A lista de linha ja pode ter lotado antes de quinta (ex.: os 18 fixos
  // confirmaram cedo). Anunciar "pode trazer convidado" nesse caso e enganoso -
  // quem tentar sera recusado na hora, depois de ja ter sido convidado a trazer
  // alguem. Sem vaga de linha, nao ha o que liberar.
  if (contarVagas(itens, partida.vagas_total).livres === 0) {
    log.info(
      { partida: partida.data_jogo },
      'lista de linha ja cheia na quinta, pulando anuncio de convidados',
    );
    return;
  }

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
 * Texto do lembrete de que a lista vai abrir.
 *
 * `noPrivado` acrescenta a valvula de escape: DM e mensagem que o BOT inicia,
 * e toda mensagem desse tipo precisa dizer como desligar (mesma regra de
 * `puxarConversa`, em handlers.ts). No grupo isso nao cabe - "nao perturbe" e
 * uma preferencia individual, respondida no privado.
 */
export function mensagemAvisoAbertura(
  dataJogo: string,
  opcoes: { noPrivado?: boolean } = {},
): string {
  const quando = rotuloData(dataJogo);
  if (!opcoes.noPrivado) {
    return [
      `⏰ Daqui a pouco abre a lista do racha de ${quando}.`,
      'A enquete sai no grupo ao meio-dia — fiquem de olho pra marcar presença.',
    ].join('\n');
  }
  return [
    `⏰ Lembrete: a lista do racha de ${quando} abre ao meio-dia, daqui a pouco.`,
    'A enquete sai no grupo do racha — é só tocar em "✅ Vou".',
    '',
    '(não quer mais esses lembretes? responde "não perturbe")',
  ].join('\n');
}

/**
 * Quarta 11:59 (CRON_AVISO_ABERTURA) — avisa quem organiza que a lista abre
 * em um minuto: no grupo do comite (GRUPO_ADMIN_JID) e no privado de cada
 * participante dele.
 *
 * Existe porque quem organiza perdia a hora de marcar a propria presenca: a
 * enquete sobe ao meio-dia no meio da conversa do grupo do racha, e quem nao
 * estava com o WhatsApp aberto naquele minuto so lembrava horas depois.
 *
 * A data vem de `proximoSabado`, nao do banco: as 11:59 a partida da semana
 * ainda NAO existe - quem a cria e `garantirPartida`, no cron das 12:00.
 */
export async function avisarAberturaAosAdmins(
  log: Log,
  /**
   * So o simulador (src/dev/simular-aviso-admins.ts) passa isto: manda o
   * aviso mesmo com a lista da semana ja aberta, que e a situacao em qualquer
   * ensaio feito fora de uma quarta 11:59.
   */
  opcoes: { mesmoComListaAberta?: boolean } = {},
): Promise<void> {
  if (!config.GRUPO_ADMIN_JID) return;

  const dataJogo = proximoSabado(new Date());

  // A lista ja aberta torna o aviso mentira ("daqui a pouco abre"). Acontece
  // quando a abertura foi recuperada fora do horario (ver
  // `recuperarAberturaPerdida`), e quem le no grupo ficaria esperando uma
  // enquete que ja esta no ar.
  const partida = await partidaAtual();
  if (
    partida?.data_jogo === dataJogo &&
    partida.enquete_id &&
    !opcoes.mesmoComListaAberta
  ) {
    log.info({ partida: dataJogo }, 'lista desta semana ja abriu, aviso nao enviado');
    return;
  }

  await sendText(
    config.GRUPO_ADMIN_JID,
    mensagemAvisoAbertura(dataJogo),
  ).catch((err) => log.warn({ err }, 'falha ao avisar o grupo do comite'));

  const participantes = await fetchGroupParticipants(config.GRUPO_ADMIN_JID).catch(
    (err) => {
      log.warn({ err }, 'falha ao consultar os membros do grupo do comite');
      return undefined;
    },
  );
  if (!participantes) return;

  const texto = mensagemAvisoAbertura(dataJogo, { noPrivado: true });
  const botTelefone = config.BOT_NUMERO
    ? `${config.BOT_NUMERO}@s.whatsapp.net`
    : undefined;
  let enviados = 0;

  for (const p of participantes) {
    // Telefone, nao lid: e o formato que abre um privado do zero (mesma razao
    // de `enviarConvitesDeAvaliacao`).
    if (!p.telefone) continue;
    if (botTelefone && p.telefone === botTelefone) continue; // o bot esta no grupo

    // Sem cadastro a pessoa nunca falou com o bot - manda mesmo assim: estar
    // no comite e o criterio aqui, e a mensagem ensina a desligar. `ehMembro`
    // tambem nao entra: o grupo do racha nao e o criterio deste aviso.
    const jogador = await buscarPorTelefone(p.telefone);
    if (jogador?.naoPerturbe) {
      log.info(
        { jogadorId: jogador.id },
        'nao_perturbe: aviso de abertura nao enviado',
      );
      continue;
    }

    enfileirar(log, { tipo: 'texto', para: p.telefone, texto });
    enviados += 1;
  }

  log.info(
    { grupo: config.GRUPO_ADMIN_JID, partida: dataJogo, enviados },
    'aviso de abertura enviado ao comite',
  );
}

/**
 * Rede de seguranca horaria da reserva: se sobrou vaga de linha com gente
 * esperando, preenche.
 *
 * O caminho normal e a promocao dentro da propria transacao da saida
 * (`promoverNaTransacao`, em domain/inscricao.ts). Isto aqui cobre o resto: o
 * container caiu no meio da transacao, ou uma inscricao foi corrigida na mao
 * no banco - ja aconteceu neste projeto. Sem isso a vaga fica aberta com
 * gente na fila por ela, e ninguem descobre ate o digest das 19h.
 *
 * So com a lista ABERTA: depois de sabado 07:00 nao ha mais vaga a preencher.
 */
async function preencherVagasPendentes(log: Log): Promise<void> {
  const partida = await partidaAtual();
  if (!partida || !listaAberta(partida)) return;

  const promovidos = await promoverPendentes(partida);
  if (!promovidos.length) return;

  log.info(
    { partida: partida.data_jogo, promovidos: promovidos.map((p) => p.nome) },
    'reserva promovida pela faxina',
  );
  const [itens, goleiros, reservas] = await Promise.all([
    listar(partida.id),
    listarGoleiros(partida.id),
    reserva.listar(partida.id),
  ]);
  await anunciar(
    log,
    [
      mensagemSubiuDaReserva(promovidos.map((p) => p.nome)),
      '',
      formatarLista(
        partida,
        itens,
        goleiros,
        config.RACHA_NOME,
        reservas,
        partida.reserva_total,
      ),
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
  // A reserva morre com a lista: nao ha mais vaga pra abrir. Fecha ANTES de
  // montar a mensagem, e cita quem ficou de fora - senao essa gente continua
  // esperando um chamado que nao vem mais.
  const ficaramDeFora = await reserva.fechar(partida.id);
  await definirStatus(partida.id, 'fechada');
  log.info(
    { partida: partida.data_jogo, ficaramDeFora: ficaramDeFora.length },
    'lista fechada',
  );
  await anunciar(
    log,
    [
      '🏁 Lista fechada! Bola em jogo às ' + config.RACHA_HORARIO.split(' ')[0] + '.',
      '',
      formatarLista(partida, itens, goleiros, config.RACHA_NOME),
      ...(ficaramDeFora.length
        ? [
            '',
            `🕒 Ficaram na reserva e não entraram: ${ficaramDeFora.map((r) => r.nome).join(', ')}. Semana que vem tem mais.`,
          ]
        : []),
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

  const [itens, goleiros, reservas] = await Promise.all([
    listar(partida.id),
    listarGoleiros(partida.id),
    reserva.listar(partida.id),
  ]);
  const vagas = contarVagas(itens, partida.vagas_total);
  const alertas = alertasDeVagas(vagas, config.ALERTA_VAGAS);

  log.info({ ocupadas: vagas.ocupadas }, 'digest do dia');
  await anunciar(
    log,
    [
      `📋 Como está a lista para ${rotuloData(partida.data_jogo)}:`,
      '',
      formatarLista(
        partida,
        itens,
        goleiros,
        config.RACHA_NOME,
        reservas,
        partida.reserva_total,
      ),
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

/**
 * Roda a cada minuto: avisa quem tem uma pergunta do bot prestes a expirar
 * ("ainda ta ai?"), em vez de deixar o prazo estourar em silencio.
 *
 * So avisa quem tem `pergunta` guardada (conversas de antes desta
 * funcionalidade nao tem o texto pra reprisar), respeita `naoPerturbe` e
 * exige telefone cadastrado - mesmas regras de qualquer mensagem que o bot
 * inicia (ver `enviarConvitesDeAvaliacao`).
 */
async function avisarConversasQuaseExpirando(log: Log): Promise<void> {
  const pendentes = await proximasAExpirar();

  for (const c of pendentes) {
    const pergunta = c.dados.pergunta;
    if (!pergunta) continue;

    const jogador = await buscarPorId(c.jogadorId);
    if (!jogador || jogador.naoPerturbe || !jogador.telefone) continue;

    await marcarAvisoExpiracao(c.jogadorId, c.partidaId, c.estado, c.dados);
    enfileirar(log, {
      tipo: 'texto',
      para: jogador.telefone,
      texto: [
        '⏰ Você tinha uma pergunta minha em aberto e o tempo tá acabando:',
        '',
        `"${pergunta}"`,
        '',
        'Ainda quer continuar? Responda "sim" ou "não".',
      ].join('\n'),
    });
  }
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
    [
      'aviso_admins',
      config.CRON_AVISO_ABERTURA,
      () => avisarAberturaAosAdmins(log),
    ],
    ['chamada', config.CRON_CHAMADA, () => chamadaDeSexta(log)],
    ['avaliacao', config.CRON_AVALIACAO, () => encerrarPartida(log)],
    ['estatisticas', config.CRON_ESTATISTICAS, () => publicarEstatisticas(log)],
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

  // A cada minuto: avisa quem tem pergunta pendente prestes a expirar. Precisa
  // ser fino (nao horario) porque o aviso tem que chegar POUCO antes do
  // prazo - CONVERSA_TTL_MIN e tipicamente dezenas de minutos.
  cron.schedule('* * * * *', () => {
    avisarConversasQuaseExpirando(log).catch((err) =>
      log.warn({ err }, 'falha ao avisar conversas quase expirando'),
    );
  });

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
    preencherVagasPendentes(log).catch((err) =>
      log.warn({ err }, 'falha ao preencher vagas com a reserva'),
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
    .then(() => preencherVagasPendentes(log))
    .catch((err) => log.warn({ err }, 'falha na faxina de boot'));
}
