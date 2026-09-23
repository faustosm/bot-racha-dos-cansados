import { config } from './config.js';
import { sendText } from './evolution/client.js';
import { normalizar, parse, parseAdmin, separarNomes } from './commands/parse.js';
import type { ComandoAdmin, Intencao } from './commands/parse.js';
import * as conversa from './conversa.js';
import {
  adicionarConvidado,
  confirmarFixo,
  desistir,
  type Confirmacao,
  type Promovido,
  jaOfertadoGoleiro,
  listar,
  listarGoleiros,
  marcarOfertaGoleiro,
  minhaInscricao,
  normalizarNome,
  removerConvidado,
  restaurarInscricao,
} from './domain/inscricao.js';
import { isoDate, proximaAberturaFixos } from './domain/datas.js';
import {
  buscarPorId,
  buscarPorNome,
  definirNaoPerturbe,
  resolver,
} from './domain/jogador.js';
import type { Jogador } from './domain/jogador.js';
import {
  avaliacaoAberta,
  convidadosLiberados,
  definirStatus,
  listaAberta,
  partidaAtual,
  partidaParaLeitura,
  partidaPorEnquete,
  partidaPorId,
} from './domain/partida.js';
import {
  OPCAO_NAO_VOU,
  OPCAO_VOU_COM_CONVIDADO,
  OPCOES,
  interpretar,
  registrarVoto,
  votoAnterior,
} from './domain/enquete.js';
import {
  OPCOES_AVALIACAO,
  conviteAvaliacaoPorEnquete,
  interpretarNota,
  registrarAvaliacao,
} from './domain/avaliacao.js';
import type { ConviteAvaliacao } from './domain/avaliacao.js';
import { decifrarVoto, opcoesEscolhidas } from './domain/voto.js';
import {
  alertasDeVagas,
  contarVagas,
  formatarLista,
  rotuloData,
  textoDePromocao,
} from './domain/lista.js';
import type { ItemLista, Partida } from './domain/tipos.js';
import { comoFalarComOBot } from './link.js';
import { ehMembro } from './grupo.js';
import { enfileirar } from './fila.js';

export interface Contexto {
  /** Identificador de grupo (@lid). Ausente em algumas mensagens privadas. */
  readonly lid?: string | undefined;
  /** Identificador de telefone (@s.whatsapp.net). */
  readonly telefone?: string | undefined;
  /** Para onde responder no privado: o JID que a Evolution aceita de volta. */
  readonly jidPrivado: string;
  readonly nome: string;
  readonly texto: string;
  readonly origem: 'grupo' | 'privado';
  readonly messageId?: string;
  readonly log: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
  };
}

/** Contexto ja com a identidade resolvida para um jogador do banco. */
interface Sessao extends Contexto {
  readonly jogadorId: number;
  /** Nome que aparece na lista (escolhido pela pessoa, ou o pushName). */
  readonly nomeNaLista: string;
  /** A pessoa ja escreveu para o bot alguma vez. */
  readonly falouNoPrivado: boolean;
  /** Pediu para o bot nao puxar conversa por conta propria. */
  readonly naoPerturbe: boolean;
}

/**
 * Intencoes que interrompem um dialogo em andamento em vez de virarem resposta.
 * "gol"/"linha"/"nao" ficam de fora de proposito: sao respostas as perguntas.
 */
const COMANDOS_FORTES = new Set<Intencao['tipo']>([
  'lista',
  'ajuda',
  'desistir',
  'confirmar',
  'quero_convidar',
  'quero_goleiro',
  'tirar_convidado',
]);

const OPCOES_NOMES = [
  'Não entendi. Aqui eu espero uma destas coisas:',
  '',
  '  o nome do seu convidado',
  '    ex: Joao',
  '  "não" (ou "nenhum") se não for levar ninguém',
].join('\n');

/**
 * Rodape curto, anexado as respostas que ENCERRAM uma acao (confirmou, saiu,
 * lista). Nunca nas perguntas de dialogo: la a pessoa deve responder a pergunta,
 * e oferecer comandos no meio so confunde.
 *
 * Curto de proposito - lista completa em toda mensagem ninguem le.
 */
const RODAPE = '💬 "lista" · "ajuda"';

// A enquete e o caminho principal desde que ela existe. A ajuda tem que
// comecar por ela - antes ensinava a digitar comandos e nem citava a enquete,
// entao quem pedia ajuda aprendia o caminho mais trabalhoso.
const AJUDA = [
  '⚽ Eu cuido da lista do racha.',
  '',
  'ENTRAR OU SAIR — é só tocar na enquete do grupo:',
  '  ✅ Vou',
  '  👥 Vou com convidado',
  '  ❌ Não vou',
  '',
  'TIRAR UM CONVIDADO',
  '  Me manda aqui: "João não vai mais"',
  '',
  'A lista tem 18 vagas de linha. Depois delas, quem marcar entra na RESERVA',
  'e sobe sozinho se alguém sair — eu te aviso aqui quando acontecer.',
  'Vale pra convidado também: entra na fila, na ordem de chegada.',
  'Cada pessoa leva 1 convidado, a partir de quinta ao meio-dia.',
  'Goleiro é contratado por fora ou convidado de um fixo, lista à parte.',
  '  Me manda aqui: "contratei um goleiro" ou "chamei um goleiro"',
  '',
  'AQUI NO PRIVADO você também pode:',
  '  "lista" — ver a lista completa',
  '  "não perturbe" — eu paro de te chamar por conta própria',
  '  ("pode chamar" religa)',
  '',
  'No grupo eu publico a lista às 19:00 e sempre que alguém sai.',
].join('\n');

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

/**
 * Manda no privado - o unico canal de conversa do bot. So e chamado para quem
 * acabou de escrever para ele: iniciar conversa com quem nunca falou e o
 * padrao classico de banimento.
 */
/**
 * RESPOSTA no privado: a pessoa escreveu, o bot responde. Sempre permitido -
 * responder e o esperado e nao caracteriza disparo.
 */
async function noPrivado(
  ctx: Sessao,
  texto: string,
  opcoes: { rodape?: boolean } = {},
): Promise<void> {
  const corpo = opcoes.rodape ? `${texto}\n\n${RODAPE}` : texto;
  await sendText(ctx.jidPrivado, corpo).catch((err) =>
    ctx.log.warn({ err, jid: ctx.jidPrivado }, 'falha ao mandar no privado'),
  );
}

/**
 * CONVERSA INICIADA pelo bot, depois de um voto na enquete.
 *
 * Vai pela fila, com espacamento, e respeita quem pediu silencio. As duas
 * coisas existem pelo mesmo motivo: e aqui que mora o risco de o numero ser
 * derrubado, nao na resposta.
 *
 * Usado num unico lugar aqui em handlers.ts: depois do voto em "Vou com
 * convidado", para perguntar o nome de quem vai junto (scheduler.ts tem o
 * outro caso de o bot escrever primeiro - os convites de avaliacao pos-jogo).
 */
/**
 * Monta a sessao de quem so votou na enquete (nunca escreveu no privado), a
 * partir do voto cru e do jogador ja resolvido. Compartilhado entre os
 * caminhos de aviso de `tratarVotoDeEnquete`/`tratarVotoConfirmacao`: os tres
 * precisam da mesma sessao minima so para puxar conversa.
 */
function sessaoDoVoto(v: VotoRecebido, votanteLid: string, jogador: Jogador): Sessao {
  return {
    lid: votanteLid,
    ...(v.votanteTelefone ? { telefone: v.votanteTelefone } : {}),
    jidPrivado: v.votanteTelefone ?? votanteLid,
    nome: jogador.nome,
    texto: '',
    origem: 'grupo',
    log: v.log,
    jogadorId: jogador.id,
    nomeNaLista: jogador.nome,
    falouNoPrivado: jogador.falouNoPrivado,
    naoPerturbe: jogador.naoPerturbe,
  };
}

function puxarConversa(ctx: Sessao, texto: string): void {
  if (ctx.naoPerturbe) {
    ctx.log.info({ jogadorId: ctx.jogadorId }, 'nao_perturbe: mensagem nao enviada');
    return;
  }
  enfileirar(ctx.log, { tipo: 'texto', para: ctx.jidPrivado, texto });
}

async function avisarGrupo(ctx: Sessao, texto: string): Promise<void> {
  if (!config.GROUP_JID) return;
  await sendText(config.GROUP_JID, texto).catch((err) =>
    ctx.log.warn({ err }, 'falha ao avisar o grupo'),
  );
}

/**
 * Avisa o admin no privado quando um voto de enquete se perde de verdade -
 * enquete desconhecida (duplicada/orfa) ou falha ao decifrar. Antes disso o
 * unico sinal era uma linha de log warn, e foi assim que o sumico do voto do
 * Welker/Thiago Miranda (20-21/08/2026, enquete duplicada) passou batido por
 * dias. `ADMIN_TELEFONE` vazio desliga o aviso.
 */
function avisarAdmin(log: Contexto['log'], texto: string): void {
  if (!config.ADMIN_TELEFONE) return;
  sendText(config.ADMIN_TELEFONE, texto).catch((err) =>
    log.warn({ err }, 'falha ao avisar o admin'),
  );
}

// ---------------------------------------------------------------------------
// Anuncios no grupo
// ---------------------------------------------------------------------------

/**
 * Publica a lista atualizada no grupo, precedida do que acabou de mudar.
 *
 * Toda entrada e toda saida republicam a lista inteira: e o controle que o
 * grupo faz hoje na mao, e a ordem de confirmacao e a informacao que eles usam
 * para saber quem chegou primeiro. O custo e uma mensagem por mudanca.
 */
/**
 * Mantem o status da partida coerente com a ocupacao real, SEM mandar mensagem.
 *
 * So bookkeeping (exibicao/futuras consultas) - a recusa do 21o usa a
 * contagem travada em `contarComLock` (inscricao.ts), nao esta coluna. Por
 * isso NAO e daqui que sai o "lotou agora": se uma inscricao for corrigida
 * direto no banco (ja aconteceu), o status pode ficar preso em 'cheia' sem a
 * lista estar cheia de verdade, e usar essa coluna como gatilho do aviso
 * engoliria em silencio o proximo fechamento real. Quem confirma
 * (`confirmarFixo`) devolve `lotouAgora` calculado na mesma contagem travada
 * que decide se cabe - e por isso imune a esse desalinhamento.
 */
async function sincronizarStatus(
  partida: Partida,
  itens: readonly ItemLista[],
): Promise<void> {
  const vagas = contarVagas(itens, partida.vagas_total);
  await definirStatus(partida.id, vagas.livres === 0 ? 'cheia' : 'aberta');
}

/**
 * Publica a lista no grupo.
 *
 * Chamar SO quando a mudanca merece interromper o grupo. Confirmacao nao
 * merece: sao dezenas por semana, e a lista atualizada sai no digest das 19:00.
 */
async function publicarLista(
  ctx: Sessao,
  partida: Partida,
  cabecalho: string,
): Promise<void> {
  const [itens, goleiros] = await Promise.all([
    listar(partida.id),
    listarGoleiros(partida.id),
  ]);
  const vagas = contarVagas(itens, partida.vagas_total);
  const alertas = alertasDeVagas(vagas, config.ALERTA_VAGAS);

  await avisarGrupo(
    ctx,
    [
      cabecalho,
      '',
      formatarLista(partida, itens, goleiros, config.RACHA_NOME),
      ...(alertas.length ? ['', ...alertas] : []),
      '',
      'Para entrar ou sair, responda na enquete do racha 👆',
    ].join('\n'),
  );
}

/**
 * Registra a ENTRADA de um FIXO (confirmacao pela enquete, ou volta de um
 * convidado orfao cujo anfitriao ja tinha saido).
 *
 * Fica em silencio, exceto em dois momentos: quando a lista acabou de lotar
 * (senao gente continua tentando entrar) e quando alguem entrou na RESERVA -
 * esse aviso e curto, so uma linha, e existe porque a pessoa marcou na
 * enquete e sem ele acharia que esta escalada. Confirmacao normal de fixo nao
 * merece mais que isso: sao dezenas por semana, e quem esta olhando o grupo ja
 * ve o proprio voto na enquete.
 */
async function registrarEntrada(
  ctx: Sessao,
  partida: Partida,
  entrada: Pick<
    Confirmacao,
    'reserva' | 'posicaoNaReserva' | 'lotouAgora' | 'novo'
  >,
  /**
   * Quem entrou. Nem sempre e quem mandou a mensagem: pelo comando de admin
   * (`tratarAdmin`) uma pessoa inscreve outra, e o anuncio de lista fechada
   * tem que dizer o nome de quem ocupou a vaga, nao o de quem digitou.
   */
  quemEntrou: string = ctx.nomeNaLista,
): Promise<void> {
  const itens = await listar(partida.id);
  await sincronizarStatus(partida, itens);

  // `novo`: trocar o voto de "Vou" para "Vou com convidado" nao muda a vaga de
  // quem ja esta na fila - avisar de novo repetiria a mesma linha no grupo.
  if (entrada.reserva && entrada.novo) {
    // Linha unica, sem republicar a lista: a fila costuma receber varias
    // pessoas seguidas, e uma lista inteira por reserva viraria mural de bot.
    await avisarGrupo(
      ctx,
      `🪑 ${quemEntrou} entrou na reserva (${entrada.posicaoNaReserva}º da fila). Se alguém sair, entra na hora.`,
    );
    return;
  }
  if (entrada.reserva) return;

  if (!entrada.lotouAgora) return;

  // O cabecalho NAO repete "lista completa": `publicarLista` ja acrescenta o
  // alerta, e o rodape da lista tambem diz. Antes a mesma frase saia tres
  // vezes na mesma mensagem.
  await publicarLista(ctx, partida, `📣 ${quemEntrou} fechou a lista!`);
}

/**
 * Registra a ENTRADA de um CONVIDADO (linha ou goleiro) e publica a lista
 * IMEDIATAMENTE, sem esperar lotar nem o digest das 19:00 (decisao de
 * 17/08/2026).
 *
 * Diferente do fixo: convidado nunca aparece na enquete do grupo, quem
 * cadastra e sempre o anfitriao no privado. Sem aviso na hora, o resto do
 * time so saberia do numero novo no digest das 19h ou quando a lista
 * lotasse - tempo de sobra para organizar time contando com um numero que ja
 * mudou.
 */
async function registrarEntradaConvidado(
  ctx: Sessao,
  partida: Partida,
  cabecalho: string,
): Promise<void> {
  const itens = await listar(partida.id);
  await sincronizarStatus(partida, itens);
  await publicarLista(ctx, partida, cabecalho);
}

/**
 * Registra uma SAIDA.
 *
 * So publica quando a saida ABRE VAGA numa posicao que estava no teto
 * (`abriuVaga` - ver `Desistencia`/`Remocao` em domain/inscricao.ts): e a
 * unica hora em que tem gente esperando essa vaga especificamente. Se a lista
 * ja tinha vaga sobrando, a saida nao destrava nada pra ninguem - o digest das
 * 19:00 ja cobre.
 *
 * Decisao de 11/09/2026, substituindo a regra antiga (so sexta/sabado): uma
 * saida de quinta a noite, DEPOIS do digest, ficava sem nenhum aviso ate a
 * proxima sexta mesmo tendo lotado - caso do Thiago Miranda, 10/09/2026.
 */
async function registrarSaida(
  ctx: Sessao,
  partida: Partida,
  cabecalho: string,
  saida: { abriuVaga: boolean; promovidos: readonly Promovido[] },
): Promise<void> {
  const itens = await listar(partida.id);
  await sincronizarStatus(partida, itens);

  // Alguem subiu da reserva: isso SEMPRE vai pro grupo, com ou sem lista
  // cheia antes. E a informacao mais util da semana pra quem estava
  // esperando - e pro resto do time, que precisa saber quem vai jogar.
  if (saida.promovidos.length) {
    const nomes = saida.promovidos.map((p) => p.nome).join(', ');
    const verbo = saida.promovidos.length > 1 ? 'entraram' : 'entrou';
    await publicarLista(
      ctx,
      partida,
      `${cabecalho}\n✅ ${nomes} ${verbo} no lugar, direto da reserva!`,
    );
    await avisarPromovidos(ctx, partida, saida.promovidos);
    return;
  }

  if (!saida.abriuVaga) return;
  await publicarLista(ctx, partida, cabecalho);
}

/**
 * Avisa no privado quem subiu da reserva.
 *
 * O anuncio no grupo nao basta: a pessoa marcou "vou" dias atras, ficou de
 * fora e nao tem motivo pra ficar conferindo a lista - ela precisa saber que
 * agora esta escalada (e que pode sair, se nao der mais).
 *
 * Mensagem que o BOT inicia: vai pela fila espacada e respeita `nao_perturbe`
 * e quem nao tem telefone cadastrado, mesmas regras de `puxarConversa` e dos
 * convites de avaliacao.
 *
 * Convidado nao tem cadastro proprio, entao o aviso dele vai para o PADRINHO
 * (22/09/2026). Ate ali esse caso era teorico - convidado so entrava havendo
 * vaga, nunca ficava na reserva - e o codigo se contentava com o anuncio no
 * grupo. Com convidado na fila virou rotina, e confiar no grupo significa o
 * padrinho descobrir no sabado que o cara dele tinha entrado.
 */
async function avisarPromovidos(
  ctx: Sessao,
  partida: Partida,
  promovidos: readonly Promovido[],
): Promise<void> {
  // Agrupa por DESTINATARIO antes de escrever: uma saida que libera duas
  // vagas pode promover o fixo e o convidado dele de uma vez, e sem isso ele
  // recebe duas mensagens seguidas quase iguais.
  const porPessoa = new Map<number, { eu: boolean; convidados: string[] }>();
  for (const p of promovidos) {
    const avisar = p.jogadorId ?? p.convidadoDeId;
    // Convidado sem padrinho (o anfitriao saiu e ele ficou) nao tem a quem
    // avisar: segue so no anuncio do grupo.
    if (avisar === null) continue;
    const atual = porPessoa.get(avisar) ?? { eu: false, convidados: [] };
    if (p.jogadorId !== null) atual.eu = true;
    else atual.convidados.push(p.nome);
    porPessoa.set(avisar, atual);
  }

  const quando = rotuloData(partida.data_jogo);
  for (const [jogadorId, quem] of porPessoa) {
    const jogador = await buscarPorId(jogadorId);
    if (!jogador || jogador.naoPerturbe || !jogador.telefone) continue;

    enfileirar(ctx.log, {
      tipo: 'texto',
      para: jogador.telefone,
      texto: [
        ...textoDePromocao(quem, quando),
        '',
        '(não quer que eu te chame? responde "não perturbe")',
      ].join('\n'),
    });
  }
}

// ---------------------------------------------------------------------------
// Dialogo no privado
// ---------------------------------------------------------------------------

/**
 * Recebe os nomes e pergunta se algum e goleiro antes de cadastrar.
 *
 * Goleiro e lista PROPRIA (nunca ocupa vaga de linha) - sem essa pergunta um
 * convidado goleiro entrava como linha e comia vaga que nao e dele (foi o que
 * aconteceu com um convidado em 12/08/2026, corrigido na mao).
 */
async function iniciarConvidados(
  ctx: Sessao,
  partida: Partida,
  nomes: readonly string[],
): Promise<void> {
  const pergunta = [
    'Todos de linha, ou tem goleiro entre eles?',
    'Se tiver, manda o nome de quem é goleiro. Se não, responda "linha".',
  ].join('\n');
  await conversa.salvar(
    ctx.jogadorId,
    partida.id,
    'aguardando_posicao_convidados',
    { nomesPendentes: nomes, pergunta },
  );
  await noPrivado(ctx, pergunta);
}

/**
 * Cadastra um lote de convidados de LINHA e resume o que entrou.
 *
 * O resumo diz ONDE cada um caiu, nao so que foi anotado: desde 22/09/2026 o
 * convidado pode entrar direto na reserva, e "Anotado: Paulo" sozinho fazia o
 * padrinho achar que tinha vaga garantida. Mesma informacao que o fixo ja
 * recebia em `registrarEntrada`.
 */
async function registrarConvidadosLinha(
  ctx: Sessao,
  partida: Partida,
  nomes: readonly string[],
): Promise<void> {
  const entraram: { nome: string; reserva: boolean; lugar: number }[] = [];
  for (const nome of nomes) {
    const r = await adicionarConvidado(partida, ctx.jogadorId, nome, 'linha');
    if (r.ok) {
      entraram.push({
        nome,
        reserva: r.valor.reserva,
        lugar: r.valor.posicaoNaReserva,
      });
    } else await noPrivado(ctx, `${nome}: ${r.motivo}`);
  }
  if (!entraram.length) return;

  const comLugar = (c: (typeof entraram)[number]): string =>
    c.reserva ? `${c.nome} 🪑 (reserva, ${c.lugar}º da fila)` : c.nome;
  const naReserva = entraram.filter((c) => c.reserva);

  await noPrivado(
    ctx,
    [
      `Anotado: ${entraram.map(comLugar).join(', ')}.`,
      ...(naReserva.length
        ? [
            naReserva.length === 1
              ? 'As vagas de linha já estão ocupadas — se alguém sair, ele entra e eu te aviso aqui.'
              : 'As vagas de linha já estão ocupadas — eles sobem na ordem se alguém sair, e eu te aviso aqui.',
          ]
        : []),
    ].join('\n'),
    { rodape: true },
  );

  // O "!" e de quem entrou pra jogar. Caindo na reserva o anuncio vira
  // informativo: comemorar vaga que nao existe e o que confundia antes.
  const rotulo = entraram.length > 1 ? 'convidados' : 'convidado';
  await registrarEntradaConvidado(
    ctx,
    partida,
    naReserva.length
      ? `👥 ${ctx.nomeNaLista} confirmou ${rotulo}: ${entraram.map(comLugar).join(', ')}.`
      : `👥 ${ctx.nomeNaLista} confirmou ${rotulo}: ${entraram.map((c) => c.nome).join(', ')}!`,
  );
}

/** Pergunta se o proximo goleiro da fila e contratado ou convidado. */
async function perguntarTipoGoleiro(
  ctx: Sessao,
  partida: Partida,
  nome: string,
  filaRestante: readonly string[],
): Promise<void> {
  const pergunta = `${nome} é contratado (por fora) ou é seu convidado mesmo?`;
  await conversa.salvar(ctx.jogadorId, partida.id, 'aguardando_tipo_goleiro', {
    filaGoleiros: [nome, ...filaRestante],
    pergunta,
  });
  await noPrivado(ctx, pergunta);
}

/** Cadastra UM goleiro (contratado ou convidado) e avisa o grupo. */
async function cadastrarGoleiro(
  ctx: Sessao,
  partida: Partida,
  nome: string,
  contratado: boolean,
): Promise<void> {
  const r = await adicionarConvidado(partida, ctx.jogadorId, nome, 'gol', {
    contratado,
    // Contratado nao tem anfitriao de verdade (ver comentario em
    // adicionarConvidado): quem arranjou nao precisa estar confirmado na
    // lista de linha pra fechar um goleiro por fora. Convidado continua
    // exigindo, e o mesmo motivo da lista de linha - quem traz precisa estar
    // no jogo.
    exigirAnfitriao: !contratado,
  });
  await noPrivado(
    ctx,
    r.ok
      ? `Anotado: ${nome} — goleiro (${contratado ? 'contratado' : 'convidado'}).`
      : `${nome}: ${r.motivo}`,
    { rodape: true },
  );

  if (r.ok) {
    await registrarEntradaConvidado(
      ctx,
      partida,
      contratado
        ? `🧤 Goleiro confirmado: ${nome} (contratado).`
        : `🧤 ${ctx.nomeNaLista} confirmou o goleiro ${nome}!`,
    );
  }
}

/**
 * Cadastra um goleiro (contratado ou convidado) e segue pra proxima da fila,
 * se houver mais de um apontado na mesma rodada.
 */
async function registrarGoleiro(
  ctx: Sessao,
  partida: Partida,
  nome: string,
  contratado: boolean,
  filaRestante: readonly string[],
): Promise<void> {
  await cadastrarGoleiro(ctx, partida, nome, contratado);

  const [proximo, ...resto] = filaRestante;
  if (proximo) {
    await perguntarTipoGoleiro(ctx, partida, proximo, resto);
    return;
  }
  await conversa.limpar(ctx.jogadorId);
}

/**
 * Cadastra uma fila de goleiros TODOS do mesmo tipo, sem perguntar item a
 * item - usado quando a frase de gatilho ja disse o tipo ("contratei um
 * goleiro"). Perguntar de novo seria repetir o que a pessoa acabou de falar.
 */
async function registrarFilaGoleiros(
  ctx: Sessao,
  partida: Partida,
  nomes: readonly string[],
  contratado: boolean,
): Promise<void> {
  for (const nome of nomes) {
    await cadastrarGoleiro(ctx, partida, nome, contratado);
  }
  await conversa.limpar(ctx.jogadorId);
}

/**
 * Reabre uma pergunta pendente DO ZERO: reenvia o texto exato que o bot tinha
 * perguntado (guardado em `dados.pergunta`) e renova o prazo cheio.
 *
 * Dois chamadores: quando a pessoa confirma "sim" ao aviso de prazo quase
 * estourando, e quando ela responde tarde demais mas ainda dentro da janela
 * de graca (`carregarExpiradaRecente`, em tratarMensagem). Os dois casos sao
 * o mesmo problema - "o prazo passou, mas a pessoa ainda quer aquilo" - e por
 * isso o mesmo reinicio serve pros dois.
 *
 * Conversas de antes desta funcionalidade nao tem `pergunta` guardada: nesse
 * caso nao ha o que reprisar, so cancela e explica.
 */
async function reiniciarPergunta(
  ctx: Sessao,
  partida: Partida,
  conv: conversa.Conversa,
): Promise<void> {
  const pergunta = conv.dados.pergunta;
  if (!pergunta) {
    await conversa.limpar(ctx.jogadorId);
    await noPrivado(
      ctx,
      'Essa pergunta que te mandei já expirou. Se ainda for isso que você quer, manda de novo do zero.',
      { rodape: true },
    );
    return;
  }
  await conversa.salvar(ctx.jogadorId, partida.id, conv.estado, {
    ...conv.dados,
    confirmandoExpiracao: undefined,
  });
  await noPrivado(ctx, pergunta);
}

async function continuarDialogo(
  ctx: Sessao,
  conv: conversa.Conversa,
  partida: Partida,
): Promise<void> {
  const intencao = parse(ctx.texto);

  // "cancelar" abandona a PERGUNTA. Nao e o mesmo que "fora", que sai do racha.
  if (intencao?.tipo === 'cancelar') {
    await conversa.limpar(ctx.jogadorId);
    await noPrivado(ctx, 'Ok, cancelei. Você continua na lista.', {
      rodape: true,
    });
    return;
  }

  // Resposta ao aviso de "prazo quase estourando" (ver avisarConversasQuaseExpirando
  // em scheduler.ts), nao a pergunta original - trata ANTES do switch por
  // estado, ja que vale pra qualquer estado.
  if (conv.dados.confirmandoExpiracao) {
    if (intencao?.tipo === 'negativa') {
      await conversa.limpar(ctx.jogadorId);
      await noPrivado(ctx, 'Beleza, deixei pra lá.', { rodape: true });
      return;
    }
    if (intencao?.tipo === 'afirmativa') {
      await reiniciarPergunta(ctx, partida, conv);
      return;
    }
    await noPrivado(ctx, 'Ainda quer continuar? Responda "sim" ou "não".');
    return;
  }

  if (conv.estado === 'aguardando_nomes') {
    if (intencao?.tipo === 'negativa') {
      await conversa.limpar(ctx.jogadorId);
        await noPrivado(
        ctx,
        'Beleza, sem convidados. Se mudar de ideia, é só falar "vou levar um convidado".',
        { rodape: true },
      );
      return;
    }
    // "Sim" nao e um nome de convidado: e um aceite. Antes disso, quem
    // respondia "Sim" ganhava um convidado chamado Sim.
    if (intencao?.tipo === 'afirmativa') {
      await noPrivado(
        ctx,
        [
          'Boa! Agora manda o NOME do seu convidado.',
          '',
          'Se desistir, responda "não".',
        ].join('\n'),
      );
      return;
    }
    const nomes = separarNomes(ctx.texto);
    if (!nomes.length) {
      await noPrivado(ctx, OPCOES_NOMES);
      return;
    }
    await iniciarConvidados(ctx, partida, nomes);
    return;
  }

  if (conv.estado === 'aguardando_posicao_convidados') {
    const pendentes = conv.dados.nomesPendentes ?? [];
    const t = normalizar(ctx.texto);

    // "não"/"nenhum" (negativa) ou "linha"/"todos" direto: ninguem e goleiro.
    const todosDeLinha =
      intencao?.tipo === 'negativa' || t === 'linha' || t === 'todos';
    if (todosDeLinha) {
      await conversa.limpar(ctx.jogadorId);
      await registrarConvidadosLinha(ctx, partida, pendentes);
      return;
    }

    // Com 1 convidado so, "goleiro"/"gol" sozinho ja basta - nao precisa
    // repetir o nome que acabou de mandar.
    const goleiros =
      pendentes.length === 1 && /\bgol(eiro)?\b/.test(t)
        ? [...pendentes]
        : pendentes.filter((nome) =>
            separarNomes(ctx.texto)
              .map(normalizarNome)
              .includes(normalizarNome(nome)),
          );

    // Dois convidados com o mesmo nome (ex.: anfitriao digitou "João, João")
    // casam os dois no filtro acima - `.includes` compara por VALOR, nao por
    // posicao no array. Sem esta checagem os dois entrariam como goleiro (ou
    // os dois sairiam da linha) sem o anfitriao ter como escolher qual e qual,
    // igual ao caso que `removerConvidado` ja trata via `{tipo:'ambiguo'}`.
    const nomeAmbiguo = goleiros.find(
      (nome) =>
        pendentes.filter((p) => normalizarNome(p) === normalizarNome(nome))
          .length > 1,
    );
    if (nomeAmbiguo) {
      await noPrivado(
        ctx,
        [
          `Tem mais de um convidado chamado "${nomeAmbiguo}" - não dá pra saber qual é o goleiro.`,
          'Cadastre de novo com nomes diferentes (ex: "João 1", "João 2") e me diga quem é o goleiro.',
        ].join('\n'),
      );
      return;
    }

    if (!goleiros.length) {
      await noPrivado(
        ctx,
        [
          `Não entendi. Os convidados são: ${pendentes.join(', ')}.`,
          'Responda "linha" se todos forem de linha, ou o nome de quem é goleiro.',
        ].join('\n'),
      );
      return;
    }

    const linha = pendentes.filter((nome) => !goleiros.includes(nome));
    await conversa.limpar(ctx.jogadorId);
    if (linha.length) await registrarConvidadosLinha(ctx, partida, linha);

    const [primeiro, ...resto] = goleiros;
    if (primeiro) await perguntarTipoGoleiro(ctx, partida, primeiro, resto);
    return;
  }

  if (conv.estado === 'aguardando_tipo_goleiro') {
    const [atual, ...resto] = conv.dados.filaGoleiros ?? [];
    if (!atual) {
      await conversa.limpar(ctx.jogadorId);
      return;
    }

    const t = normalizar(ctx.texto);
    if (t.includes('contratad')) {
      await registrarGoleiro(ctx, partida, atual, true, resto);
      return;
    }
    if (t.includes('convidad')) {
      await registrarGoleiro(ctx, partida, atual, false, resto);
      return;
    }
    await noPrivado(ctx, `Não entendi. ${atual} é "contratado" ou "convidado"?`);
    return;
  }

  if (conv.estado === 'aguardando_nomes_goleiro') {
    if (intencao?.tipo === 'negativa') {
      await conversa.limpar(ctx.jogadorId);
      await noPrivado(
        ctx,
        'Beleza, cancelei. Se mudar de ideia, é só falar "contratei um goleiro".',
        { rodape: true },
      );
      return;
    }
    const nomes = separarNomes(ctx.texto);
    if (!nomes.length) {
      await noPrivado(
        ctx,
        'Não entendi. Manda o nome do goleiro (ou dos dois, separados por vírgula).',
      );
      return;
    }

    const contratadoImplicito = conv.dados.contratadoImplicito ?? false;
    await conversa.limpar(ctx.jogadorId);
    // O verbo do gatilho ja disse o tipo ("contratei"): cadastra a fila
    // inteira direto, sem perguntar de novo por nome. Gatilho ambiguo
    // ("chamei"/"add") cai no mesmo dialogo de sempre, um de cada vez.
    if (contratadoImplicito) {
      await registrarFilaGoleiros(ctx, partida, nomes, true);
      return;
    }
    const [primeiro, ...resto] = nomes;
    if (primeiro) await perguntarTipoGoleiro(ctx, partida, primeiro, resto);
    return;
  }

  if (conv.estado === 'convidados_orfaos') {
    const candidatos = conv.dados.candidatos ?? [];

    const ficam =
      intencao?.tipo === 'todos' ||
      (candidatos.length === 1 && intencao?.tipo === 'afirmativa')
        ? candidatos
        : intencao?.tipo === 'numeros'
          ? candidatos.filter((c) => intencao.numeros.includes(c.indice))
          : undefined;

    // "cancelar" ja foi tratado no topo do dialogo.
    if (intencao?.tipo === 'negativa' || intencao?.tipo === 'desistir') {
      await conversa.limpar(ctx.jogadorId);
      await noPrivado(ctx, 'Ok, eles ficam fora da lista.', { rodape: true });
      return;
    }

    if (!ficam || !ficam.length) {
      const numerada = candidatos.map((c) => `${c.indice}. ${c.nome}`).join('\n');
      await noPrivado(
        ctx,
        [
          `Não entendi "${ctx.texto.trim()}".`,
          '',
          numerada,
          '',
          candidatos.length === 1
            ? 'Ele vai mesmo assim? "sim" ou "não".'
            : 'Responda o número (ou "1, 2"), "todos", ou "não".',
        ].join('\n'),
      );
      return;
    }

    await conversa.limpar(ctx.jogadorId);

    const voltaram: string[] = [];
    for (const c of ficam) {
      // Restaura a inscricao original em vez de criar outra: preserva o
      // criado_em e, com ele, o lugar da pessoa na ordem de chegada.
      const r =
        c.inscricaoId !== undefined
          ? await restaurarInscricao(partida, c.inscricaoId)
          : await adicionarConvidado(
              partida,
              ctx.jogadorId,
              c.nome,
              c.posicao,
              { exigirAnfitriao: false },
            );
      if (r.ok) voltaram.push(c.nome);
      else await noPrivado(ctx, `${c.nome}: ${r.motivo}`);
    }
    if (!voltaram.length) return;

    await noPrivado(ctx, `Beleza, ${voltaram.join(', ')} continua na lista.`, {
      rodape: true,
    });
    const verbo = voltaram.length > 1 ? 'continuam' : 'continua';
    await registrarEntradaConvidado(
      ctx,
      partida,
      `👥 ${voltaram.join(', ')} ${verbo} na lista, mesmo sem ${ctx.nomeNaLista}!`,
    );
    return;
  }

  // Nenhum outro estado precisa de tratamento: convidados entram direto e o
  // unico dialogo restante e o de convidado orfao, tratado acima.
}

// ---------------------------------------------------------------------------
// Intencoes
// ---------------------------------------------------------------------------

async function tratarConfirmar(ctx: Sessao, partida: Partida): Promise<void> {
  const r = await confirmarFixo(partida, ctx.jogadorId, 'linha');
  if (!r.ok) {
    await noPrivado(ctx, r.motivo, { rodape: true });
    return;
  }

  if (r.valor.jaEstava) {
    // "Ja estava" sozinho deixava a pessoa sem saber o proximo passo (saiu?
    // quer convidar?). O convite agora e oferecido sempre: com a lista cheia
    // o convidado entra na reserva em vez de ser recusado, entao sugerir isso
    // nao cria mais a expectativa falsa do caso Thiago Juliano/Gustavo.
    const linhas = [
      r.valor.reserva
        ? `Você já está na lista, na RESERVA (${r.valor.posicaoNaReserva}º da fila) 🪑. Se abrir vaga, você entra e eu te aviso.`
        : 'Você já está confirmado na lista ✅.',
      `Pra sair, muda seu voto pra "${OPCAO_NAO_VOU}" na enquete (ou responde "não vou mais" aqui).`,
      `Pra levar um convidado, muda pra "${OPCAO_VOU_COM_CONVIDADO}" (ou manda "quero levar convidado" aqui).`,
      'Outras opções: "ajuda".',
    ];
    await noPrivado(ctx, linhas.join('\n'), { rodape: true });
    // Nada mudou na lista: republicar seria so ruido.
    return;
  }

  await noPrivado(
    ctx,
    r.valor.reserva
      ? [
          `🪑 Você está na RESERVA, ${r.valor.posicaoNaReserva}º da fila.`,
          `As ${partida.vagas_total} vagas de linha já estão ocupadas — se alguém sair, você entra automaticamente e eu te aviso aqui.`,
        ].join('\n')
      : `Confirmado como ${r.valor.posicao}. ✅`,
    { rodape: true },
  );

  await registrarEntrada(ctx, partida, r.valor);

  // Quem esta na reserva tambem leva convidado: o convidado entra na fila
  // atras dele, e os dois sobem na ordem (decisao de 22/09/2026).
  if (!r.valor.novo) return;

  // A pergunta sobre convidados so faz sentido depois de quinta 12:00.
  if (convidadosLiberados(partida)) {
    const pergunta = [
      'Vai levar convidado?',
      'Manda o nome dele, ou responda "não".',
    ].join('\n');
    await conversa.salvar(ctx.jogadorId, partida.id, 'aguardando_nomes', {
      pergunta,
    });
    await noPrivado(ctx, pergunta);
  }
}

/**
 * @param opcoes.origemVoto true quando veio de um voto na enquete do grupo.
 *
 * A distincao importa: acionado por VOTO (ex.: pergunta sobre convidados
 * orfaos), qualquer mensagem no privado e conversa que o BOT inicia - tem que
 * passar pela fila e respeitar quem pediu silencio. Acionado por texto no
 * privado, e resposta, e sai direto.
 *
 * Quem tenta sair sem ter inscricao ativa (nunca confirmou, ou ja tinha saido)
 * fica em silencio - nao ha nada de errado nisso, nao precisa de aviso.
 */
async function tratarDesistir(
  ctx: Sessao,
  partida: Partida,
  opcoes: { origemVoto?: boolean } = {},
): Promise<void> {
  const falarNoPrivado = (texto: string): void => {
    if (opcoes.origemVoto) puxarConversa(ctx, texto);
    else void noPrivado(ctx, texto);
  };

  const r = await desistir(partida, ctx.jogadorId);
  if (!r.ok) return; // nao estava na lista - tudo bem, sem aviso

  await conversa.limpar(ctx.jogadorId);

  const convidados = r.valor.convidados;
  const n = convidados.length;
  const extra = n > 0 ? ` (levou ${n} convidado${n > 1 ? 's' : ''} junto)` : '';

  const cabecalho = `❌ ${ctx.nomeNaLista} não vai mais${extra}. Liberou vaga!`;
  await registrarSaida(ctx, partida, cabecalho, r.valor);

  if (n === 0) return;

  // Saiu com convidados: eles podem ir mesmo sem quem os trouxe. Perguntar e
  // melhor do que decidir - a vaga e de alguem.
  const candidatos: conversa.Candidato[] = convidados.map((c, i) => ({
    indice: i + 1,
    nome: c.nome,
    posicao: c.posicao,
    inscricaoId: c.id,
  }));
  const numerada = candidatos
    .map(
      (c) => `${c.indice}. ${c.nome}`,
    )
    .join('\n');
  const pergunta = [
    n === 1
      ? 'Seu convidado saiu junto:'
      : 'Seus convidados saíram junto:',
    numerada,
    '',
    n === 1
      ? 'Ele vai mesmo assim? Responda "sim" ou "não".'
      : 'Algum deles vai mesmo assim?',
    n === 1
      ? ''
      : 'Responda o número (ou "1, 2"), "todos", ou "não" se nenhum vai.',
  ]
    .filter((l) => l !== '')
    .join('\n');
  await conversa.salvar(ctx.jogadorId, partida.id, 'convidados_orfaos', {
    candidatos,
    pergunta,
  });
  falarNoPrivado(pergunta);
}

async function tratarConvidados(
  ctx: Sessao,
  partida: Partida,
  nomes: string[],
): Promise<void> {
  if (!convidadosLiberados(partida)) {
    await noPrivado(
      ctx,
      'Convidados só a partir de quinta, meio-dia. Até lá a lista é dos fixos.',
      { rodape: true },
    );
    return;
  }
  await iniciarConvidados(ctx, partida, nomes);
}

/**
 * "Vou levar um convidado" - a pessoa disse a intencao, nao o nome. O bot
 * pergunta quem, em vez de exigir que ela saiba a sintaxe "+nome".
 */
async function tratarQueroConvidar(
  ctx: Sessao,
  partida: Partida,
): Promise<void> {
  if (!convidadosLiberados(partida)) {
    await noPrivado(
      ctx,
      'Convidados só a partir de quinta, meio-dia. Até lá a lista é dos fixos.',
      { rodape: true },
    );
    return;
  }

  const pergunta = [
    'Boa! Quem você vai levar?',
    'Manda o nome.',
    '',
    '("cancelar" se mudou de ideia)',
  ].join('\n');
  await conversa.salvar(ctx.jogadorId, partida.id, 'aguardando_nomes', {
    pergunta,
  });
  await noPrivado(ctx, pergunta);
}

/**
 * "Contratei um goleiro" / "chamei um goleiro" - a pessoa disse a intencao,
 * nao o nome. Ao contrario do convidado de linha, goleiro NAO espera a janela
 * de quinta 12:00: e lista propria, sem teto compartilhado com os fixos, e
 * quem organiza pode precisar fechar um goleiro contratado cedo na semana
 * (decisao de 10/09/2026 - ate entao o gate de convidados barrava isso sem
 * motivo, ja que goleiro nunca disputou vaga com fixo).
 */
async function tratarQueroGoleiro(
  ctx: Sessao,
  partida: Partida,
  contratadoImplicito: boolean,
): Promise<void> {
  const pergunta = [
    'Boa! Qual o nome do goleiro?',
    'Se forem dois, separe por vírgula:',
    '  João, Pedro',
    '',
    '("cancelar" se mudou de ideia)',
  ].join('\n');
  await conversa.salvar(ctx.jogadorId, partida.id, 'aguardando_nomes_goleiro', {
    contratadoImplicito,
    pergunta,
  });
  await noPrivado(ctx, pergunta);
}

/**
 * Tira um convidado da lista, pelo nome, sem dialogo.
 *
 * Uma mensagem resolve o caso comum. O caso raro - dois convidados com o mesmo
 * nome - e o unico que pede uma segunda mensagem, e paga o proprio custo.
 */
async function tratarTirarConvidado(
  ctx: Sessao,
  partida: Partida,
  nome: string,
): Promise<void> {
  const r = await removerConvidado(partida, ctx.jogadorId, nome);

  if (r.tipo === 'sem_convidados') {
    await noPrivado(ctx, 'Você não tem convidados nesta lista.', {
      rodape: true,
    });
    return;
  }

  if (r.tipo === 'nao_encontrado') {
    // Devolve a lista dela junto: resolve na mesma mensagem em vez de mandar
    // a pessoa procurar o nome certo em outro lugar.
    await noPrivado(
      ctx,
      [
        `Você não tem nenhum convidado chamado "${nome}".`,
        `Seus convidados: ${r.seus.join(', ')}`,
      ].join('\n'),
    );
    return;
  }

  if (r.tipo === 'ambiguo') {
    await noPrivado(
      ctx,
      [
        `Você tem ${r.quantos} convidados chamados "${r.nome}".`,
        'Escreva o nome completo, como "João Silva".',
      ].join('\n'),
    );
    return;
  }

  await noPrivado(ctx, `Tirei o ${r.nome} da lista.`, { rodape: true });
  await registrarSaida(
    ctx,
    partida,
    `❌ ${r.nome} (convidado de ${ctx.nomeNaLista}) não vai mais. Liberou vaga!`,
    { abriuVaga: r.abriuVaga, promovidos: r.promovidos },
  );
}

// ---------------------------------------------------------------------------
// Comando de admin
// ---------------------------------------------------------------------------

const AJUDA_ADMIN = [
  '🔧 Comando de admin (só responde pro seu número):',
  '',
  '  "admin add Fulano"',
  '    põe na lista, como fixo de linha, alguém que o bot já conhece.',
  '',
  'Serve pra quem não consegue votar na enquete — sem o celular na mão, por exemplo.',
  'Use o nome como ele aparece na lista; se houver mais de um parecido, eu pergunto.',
  'Não anuncio nada no grupo na hora: a lista sai às 19:00, como sempre, ou na hora em que as vagas fecharem.',
  'Com as vagas cheias ele entra na reserva, na ordem — igual a qualquer um.',
].join('\n');

/**
 * Digitos do telefone dentro de um JID: "5534..:12@s.whatsapp.net" -> "5534..".
 *
 * Devolve vazio para @lid: o LID tambem e uma sequencia de digitos, e sem
 * este corte ele entraria na comparacao como se fosse telefone.
 */
function digitosDoTelefone(jid: string): string {
  if (jid.endsWith('@lid')) return '';
  return (jid.split('@')[0] ?? '').split(':')[0]?.replace(/\D/g, '') ?? '';
}

/**
 * A mensagem veio do telefone que administra o racha?
 *
 * Compara so os digitos porque o mesmo numero chega escrito de formas
 * diferentes conforme o canal. O LID NAO serve de credencial aqui: e opaco,
 * muda por grupo e nao e o que esta no .env - a autorizacao e sempre pelo
 * telefone (`ADMIN_TELEFONE`), e vazio desliga o comando por completo.
 */
function ehAdmin(ctx: Sessao): boolean {
  const esperado = digitosDoTelefone(config.ADMIN_TELEFONE);
  if (!esperado) return false;
  // `jidPrivado` junto com `telefone` porque nem toda mensagem privada traz
  // os dois campos preenchidos (ver `Contexto`) - no privado o jidPrivado e o
  // proprio remetente, entao os dois apontam para a mesma pessoa.
  return [ctx.telefone, ctx.jidPrivado].some(
    (jid) => jid !== undefined && digitosDoTelefone(jid) === esperado,
  );
}

/**
 * Inscreve na lista alguem que nao consegue votar na enquete.
 *
 * O caso real: 16/09/2026, o Wibio estava sem o aparelho em maos e a
 * inscricao dele teve que ser feita na mao, direto no banco. Votar por
 * terceiro e impossivel - o voto do WhatsApp e cifrado e assinado com o JID
 * de quem vota (ver domain/voto.ts) -, entao o caminho tem que ser este.
 *
 * Passa pelo MESMO `confirmarFixo` de qualquer confirmacao: mesma trava,
 * mesmo teto de vagas, mesma idempotencia. E, como qualquer confirmacao de
 * fixo, e silencioso no grupo - a lista so sai no digest das 19:00 ou no
 * momento em que esta entrada fecha as vagas (`lotouAgora`).
 *
 * Duas ausencias deliberadas:
 *
 *   - o voto NAO e registrado (`registrarVoto`): a pessoa nao votou, e a
 *     tabela `voto` alimenta a contagem de votantes das estatisticas.
 *   - a pessoa inscrita NAO recebe mensagem: ela pode estar justamente sem o
 *     celular, e pode nunca ter falado com o bot - puxar conversa com quem
 *     nunca escreveu e o que derruba o numero (ver `puxarConversa`).
 */
async function tratarAdmin(
  ctx: Sessao,
  partida: Partida,
  cmd: ComandoAdmin,
): Promise<void> {
  if (cmd.tipo === 'ajuda') {
    await noPrivado(ctx, AJUDA_ADMIN);
    return;
  }

  // Mesma janela de todo mundo: inscrever antes de a lista abrir furaria a
  // ordem de chegada dos fixos, que e o controle que o grupo usa.
  if (!listaAberta(partida)) {
    await noPrivado(
      ctx,
      `A lista de ${rotuloData(partida.data_jogo)} não está aberta agora — não dá pra inscrever ninguém.`,
      { rodape: true },
    );
    return;
  }

  const candidatos = await buscarPorNome(cmd.nome);

  if (!candidatos.length) {
    await noPrivado(
      ctx,
      [
        `Não achei ninguém chamado "${cmd.nome}".`,
        'Só consigo inscrever quem eu já conheço: quem já votou na enquete ou já falou comigo alguma vez.',
      ].join('\n'),
    );
    return;
  }

  if (candidatos.length > 1) {
    await noPrivado(
      ctx,
      [
        `Tem mais de um "${cmd.nome}":`,
        ...candidatos.map((c) => `  ${c.nome}`),
        '',
        'Manda o nome completo, como ele aparece na lista.',
      ].join('\n'),
    );
    return;
  }

  const alvo = candidatos[0];
  if (!alvo) return;

  const r = await confirmarFixo(partida, alvo.id, 'linha');
  if (!r.ok) {
    await noPrivado(ctx, `${alvo.nome}: ${r.motivo}`, { rodape: true });
    return;
  }

  if (r.valor.jaEstava) {
    await noPrivado(ctx, `${alvo.nome} já está na lista ✅.`, { rodape: true });
    return;
  }

  ctx.log.info(
    { admin: ctx.nomeNaLista, alvo: alvo.nome, partida: partida.data_jogo },
    'admin inscreveu jogador na lista',
  );

  // Publica no grupo SE, e so se, esta entrada fechou as vagas - a mesma
  // regra de qualquer confirmacao. A resposta ao admin vem depois, para nao
  // dizer "nao anunciei" um instante antes de anunciar.
  await registrarEntrada(ctx, partida, r.valor, alvo.nome);

  const vagas = contarVagas(await listar(partida.id), partida.vagas_total);
  const resposta = r.valor.reserva
    ? `Coloquei ${alvo.nome} na RESERVA 🪑 (${r.valor.posicaoNaReserva}º da fila) — as ${vagas.total} vagas de linha já estavam ocupadas. Avisei no grupo em uma linha; ele entra sozinho se alguém sair.`
    : r.valor.lotouAgora
      ? `Coloquei ${alvo.nome} na lista ✅ — e com ele fechou (${vagas.ocupadas}/${vagas.total}), então publiquei no grupo.`
      : `Coloquei ${alvo.nome} na lista ✅ (${vagas.ocupadas}/${vagas.total}). Não anunciei no grupo — a lista sai às 19:00.`;
  await noPrivado(ctx, resposta, { rodape: true });
}

// ---------------------------------------------------------------------------
// Voto na enquete do grupo
// ---------------------------------------------------------------------------

export interface VotoRecebido {
  readonly enqueteId?: string | undefined;
  readonly criadorJid?: string | undefined;
  readonly votanteLid?: string | undefined;
  readonly votanteTelefone?: string | undefined;
  readonly nome?: string | undefined;
  readonly encPayload: Uint8Array;
  readonly encIv: Uint8Array;
  readonly log: Contexto['log'];
}

/**
 * Decifra um voto e avisa o log se nao conseguir. Compartilhado entre
 * `tratarVotoConfirmacao` e `tratarVotoAvaliacao`: os dois decifram do mesmo
 * jeito, so o segredo muda (da partida ou do convite individual) - extraido
 * para que uma mudanca no contrato de `decifrarVoto` (ver domain/voto.ts, ja
 * precisou de ajuste por causa das particularidades de LID/grupo) nao corra o
 * risco de ser aplicada num handler e esquecida no outro.
 */
function decifrarOuAvisar(
  v: VotoRecebido,
  segredoBase64: string,
  mensagemAviso: string,
): string[] | undefined {
  if (!v.enqueteId || !v.criadorJid || !v.votanteLid) return undefined;

  const hashes = decifrarVoto(
    { encPayload: v.encPayload, encIv: v.encIv },
    {
      enqueteId: v.enqueteId,
      criadorJid: v.criadorJid,
      votanteJid: v.votanteLid,
      segredo: Uint8Array.from(Buffer.from(segredoBase64, 'base64')),
    },
  );
  if (!hashes) {
    v.log.warn({ enqueteId: v.enqueteId }, mensagemAviso);
    avisarAdmin(
      v.log,
      `⚠️ ${mensagemAviso} (${v.nome ?? v.votanteLid ?? '?'}, enquete ${v.enqueteId}).`,
    );
  }
  return hashes;
}

/**
 * Um voto de enquete pode ser da enquete de CONFIRMACAO (grupo, uma por
 * partida) ou de um CONVITE de AVALIACAO (privado, um por jogador - ver
 * domain/avaliacao.ts). Descobre qual e antes de decifrar.
 */
export async function tratarVotoDeEnquete(v: VotoRecebido): Promise<void> {
  if (!v.enqueteId || !v.criadorJid || !v.votanteLid) return;

  const partidaConfirmacao = await partidaPorEnquete(v.enqueteId);
  if (partidaConfirmacao?.enquete_segredo) {
    await tratarVotoConfirmacao(partidaConfirmacao, v);
    return;
  }

  const convite = await conviteAvaliacaoPorEnquete(v.enqueteId);
  if (convite) {
    await tratarVotoAvaliacao(convite, v);
    return;
  }

  // warn, nao info: um voto pra um enqueteId que nao bate com nada e SEMPRE
  // um voto perdido de verdade - nao tem retry nem forma de recuperar o
  // conteudo depois (a enquete do WhatsApp e cifrada por enqueteId, sem casar
  // o id nao ha segredo pra decifrar). A causa mais provavel e enquete
  // duplicada na abertura (corrigido em 761821c) - mas so o log em warn evita
  // que o proximo caso passe batido de novo em silencio.
  v.log.warn({ enqueteId: v.enqueteId }, 'voto de enquete desconhecida - voto perdido, sem forma de recuperar');
  avisarAdmin(
    v.log,
    `⚠️ Voto perdido: ${v.nome ?? v.votanteLid ?? '?'} votou numa enquete que eu não reconheço (${v.enqueteId}) - provavelmente enquete duplicada/órfã. Não dá pra recuperar o voto; confirme com a pessoa direto.`,
  );

  // Alem do admin, avisa quem votou: hoje ela nao recebe nada e so descobre
  // que o voto sumiu quando reparar que nao esta na lista. puxarConversa
  // (nao noPrivado) respeita naoPerturbe e vai pela fila espacada.
  const jogador = await resolver({
    lid: v.votanteLid,
    telefone: v.votanteTelefone,
    nome: v.nome ?? v.votanteLid,
    noPrivado: false,
  });
  puxarConversa(
    sessaoDoVoto(v, v.votanteLid, jogador),
    'Seu voto não foi registrado (bug de enquete). Se era pra confirmar presença no racha, me manda "vou" aqui que eu confirmo direto. Se não, fala com os administradores.',
  );
}

/** Resposta no privado pra quem votou de novo na mesma opcao. So leitura. */
async function textoVotoRepetido(
  partida: Partida,
  jogadorId: number,
  naoVou: boolean,
): Promise<string> {
  const quando = rotuloData(partida.data_jogo);
  if (naoVou) {
    return `Seu voto "${OPCAO_NAO_VOU}" já tava registrado — você está fora da lista de ${quando}.`;
  }
  const inscricao = await minhaInscricao(partida.id, jogadorId);
  if (!inscricao) {
    return `Seu voto já tava registrado, mas você não está na lista de ${quando}. Me manda "vou" aqui que eu confirmo.`;
  }
  if (inscricao.posicao === 'linha') {
    const linha = await listar(partida.id);
    const pos = linha.findIndex((i) => i.jogadorId === jogadorId) + 1;
    if (pos > partida.vagas_total) {
      return `Seu voto já tava registrado ✅ Você está na RESERVA (${pos - partida.vagas_total}º da fila) 🪑.`;
    }
  }
  return `Seu voto já tava registrado ✅ Você está na lista de ${quando}.`;
}

/**
 * Um voto na enquete de CONFIRMACAO do grupo. E o caminho principal de
 * confirmacao: um toque, sem sair da conversa, sem o bot precisar escrever
 * para ninguem.
 */
async function tratarVotoConfirmacao(
  partida: Partida,
  v: VotoRecebido,
): Promise<void> {
  // Repete a guarda do despachante: cada handler fica seguro de chamar por
  // conta propria, sem depender de o TypeScript enxergar a checagem alheia.
  if (!v.enqueteId || !v.criadorJid || !v.votanteLid || !partida.enquete_segredo) {
    return;
  }

  const hashes = decifrarOuAvisar(
    v,
    partida.enquete_segredo,
    'nao consegui decifrar o voto',
  );
  if (!hashes) return;

  const escolhidas = opcoesEscolhidas(hashes, OPCOES);
  // Desmarcar tudo nao e o mesmo que dizer "nao vou": e so tirar a resposta.
  // Mexer na lista aqui seria decidir por quem nao decidiu.
  if (!escolhidas.length) {
    v.log.info({ votante: v.votanteLid }, 'voto vazio (desmarcou), ignorando');
    return;
  }

  const opcao = escolhidas[0] ?? '';
  const acao = interpretar(opcao);
  if (!acao) return;

  // O toque foi real (WhatsApp so manda pollUpdateMessage quando a pessoa
  // escolhe uma opcao, nunca por rolar o historico) - so que numa enquete que
  // nao vale mais: de um racha ja fechado (a mais comum, enquete antiga ainda
  // visivel no chat) ou de um racha que ainda nem abriu pra confirmacao. Sem
  // aviso, o toque simplesmente nao faz nada e a pessoa acha que confirmou -
  // caso do Marcus Vinicius, 03/09/2026: votou na enquete do racha anterior
  // pensando que era a da semana, e so descobriu dias depois que nao estava
  // na lista.
  if (!listaAberta(partida)) {
    v.log.info({ partida: partida.data_jogo }, 'voto fora da janela, avisando quem votou');
    const jogador = await resolver({
      lid: v.votanteLid,
      telefone: v.votanteTelefone,
      nome: v.nome ?? v.votanteLid,
      noPrivado: false,
    });
    const aindaNaoAbriu = new Date() < new Date(partida.abre_fixos);
    puxarConversa(
      sessaoDoVoto(v, v.votanteLid, jogador),
      aindaNaoAbriu
        ? `Essa enquete ainda não abriu pra confirmação (racha de ${rotuloData(partida.data_jogo)}). Espera abrir ou me manda "vou" aqui que eu confirmo direto.`
        : `Essa enquete é de um racha que já fechou (${rotuloData(partida.data_jogo)}) — seu toque não valeu. Procura a enquete mais recente lá no grupo, ou me manda "vou" aqui que eu confirmo direto.`,
    );
    return;
  }

  const jogador = await resolver({
    lid: v.votanteLid,
    telefone: v.votanteTelefone,
    nome: v.nome ?? v.votanteLid,
    // Votar no grupo NAO abre canal privado: quem so votou nunca escreveu.
    noPrivado: false,
  });

  const ctx: Sessao = sessaoDoVoto(v, v.votanteLid, jogador);

  const anterior = await votoAnterior(partida.id, ctx.jogadorId);
  v.log.info(
    { votante: ctx.nomeNaLista, opcao, anterior: anterior ?? null },
    'voto recebido',
  );

  // Mesma opcao de novo: a pessoa tocou outra vez (reentrega do webhook ja cai
  // no dedupe por id em server.ts). Anunciar no grupo repetiria a mesma
  // informacao; so no privado, pra ela saber que o toque nao se perdeu - caso
  // do Bricyo Xavier, 23/09/2026. Le a lista de verdade em vez de confiar no
  // voto: um admin pode ter tirado a pessoa depois.
  if (anterior === opcao) {
    puxarConversa(ctx, await textoVotoRepetido(partida, ctx.jogadorId, acao.tipo === 'desistir'));
    return;
  }

  if (acao.tipo === 'desistir') {
    await tratarDesistir(ctx, partida, { origemVoto: true });
    await registrarVoto(partida.id, ctx.jogadorId, opcao);
    return;
  }

  const r = await confirmarFixo(partida, ctx.jogadorId, 'linha');
  if (!r.ok) {
    // Lista cheia nao cai mais aqui: fixo sempre entra, nem que seja na
    // reserva (ver `motivoDeCapacidade`). O que sobra sao recusas de verdade,
    // e elas precisam aparecer - o voto ficou marcado na enquete e a pessoa
    // acharia que entrou.
    //
    // O voto NAO e registrado aqui de proposito: registrar uma tentativa que
    // falhou faria a proxima tentativa identica ser silenciada pelo dedupe, e
    // a pessoa nunca entraria quando abrisse vaga.
    await avisarGrupo(ctx, `⚠️ ${ctx.nomeNaLista}: ${r.motivo}`);
    return;
  }

  const comConvidado = acao.tipo === 'confirmar_com_convidado';

  // O voto so vira o "anterior" das proximas vezes quando TUDO que ele pedia
  // aconteceu. "Vou com convidado" antes de quinta 12:00 entrega metade: a
  // presenca entra, o convidado nao. Registrar assim mesmo faria o dedupe do
  // topo desta funcao engolir a segunda tentativa, e a pessoa nunca seria
  // chamada pra dizer o nome - mesmo motivo pelo qual a recusa de
  // `confirmarFixo`, acima, tambem nao registra.
  if (!comConvidado || convidadosLiberados(partida)) {
    await registrarVoto(partida.id, ctx.jogadorId, opcao);
  }

  // O anuncio segue a OPCAO, nao o estado da lista. Trocar "Vou" por "Vou com
  // convidado" nao muda a vaga - `confirmarFixo` devolve "ja estava" - mas
  // muda o recado, e foi justamente isso que passou batido antes.
  //
  // O texto deixa o PENDENTE visivel: entre o voto e a resposta com o nome, o
  // convidado ainda nao existe na lista. Assim o proprio grupo cobra, sem o
  // bot precisar insistir no privado.
  // Confirmacao NAO interrompe o grupo: sao dezenas por semana e a lista sai
  // no digest das 19:00. So o "lotou agora" escapa daqui.
  await registrarEntrada(ctx, partida, r.valor);

  if (!comConvidado) return;

  // Antes de quinta 12:00 convidado nem existe. O voto de quem pediu convidado
  // cedo nao foi registrado (ver acima), entao votar de novo depois que abrir
  // nao cai no dedupe do topo desta funcao e a pergunta sai de verdade.
  if (!convidadosLiberados(partida)) {
    puxarConversa(
      ctx,
      '⏳ Convidado só a partir de quinta ao meio-dia. Vote de novo depois que abrir que eu te chamo.',
    );
    return;
  }

  // Unico ponto em que o bot puxa conversa. Vai pela fila (espacada) e respeita
  // quem pediu silencio - as duas protecoes vivem dentro de puxarConversa.
  const pergunta = [
    jogador.falouNoPrivado
      ? 'Você marcou na enquete que vai levar convidado 👥'
      : 'Oi! Eu cuido da lista do racha ⚽\nVocê marcou na enquete que vai levar convidado.',
    '',
    'Quem você vai levar? Manda o nome.',
    '',
    '("cancelar" se mudou de ideia)',
  ].join('\n');
  await conversa.salvar(ctx.jogadorId, partida.id, 'aguardando_nomes', {
    pergunta,
  });
  puxarConversa(ctx, pergunta);
}

/**
 * Um voto no CONVITE individual de avaliacao (nota 0-5 pos-jogo, enviado no
 * privado so para quem efetivamente jogou - ver `encerrarPartida` em
 * scheduler.ts). Mais simples que a confirmacao: como o convite ja nasce
 * vinculado a UM jogador especifico (`criarConviteAvaliacao`), nao precisa
 * decidir quem e elegivel aqui - so decifrar com o segredo daquele convite e
 * gravar. `resolver()` nao entra nesse caminho.
 *
 * Silencioso de proposito: nota nao gera anuncio nenhum, so entra na media
 * mensal, futuramente.
 */
async function tratarVotoAvaliacao(
  convite: ConviteAvaliacao,
  v: VotoRecebido,
): Promise<void> {
  if (!v.enqueteId || !v.criadorJid || !v.votanteLid) return;

  const hashes = decifrarOuAvisar(
    v,
    convite.enquete_segredo,
    'nao consegui decifrar a avaliacao',
  );
  if (!hashes) return;

  const escolhidas = opcoesEscolhidas(hashes, OPCOES_AVALIACAO);
  if (!escolhidas.length) return; // desmarcou tudo

  const nota = interpretarNota(escolhidas[0] ?? '');
  if (nota === undefined) return;

  const partida = await partidaPorId(convite.partida_id);
  if (!partida || !avaliacaoAberta(partida)) {
    v.log.info(
      { partidaId: convite.partida_id },
      'avaliacao fora da janela, ignorada',
    );
    return;
  }

  await registrarAvaliacao(convite.id, nota);
  v.log.info(
    { jogadorId: convite.jogador_id, nota, partidaId: convite.partida_id },
    'avaliacao registrada',
  );
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

/**
 * Unico comando aceito no grupo. E somente LEITURA: acionado por engano, o pior
 * que acontece e uma mensagem a mais - nada muda na lista de ninguem.
 *
 * O que NAO entra aqui e o que altera estado ("vou", "fora", "+convidado").
 * Esses casam por prefixo, entao "vou almocar" colocaria a pessoa na lista sem
 * querer; num grupo de 50 pessoas isso e questao de tempo, nao hipotese.
 * "lista" casa por igualdade exata: "manda a lista ai" nao aciona.
 */
const LEITURA_NO_GRUPO = new Set<Intencao['tipo']>(['lista', 'ajuda']);

/** Ajuda para quem ainda nao falou com o bot: explica e entrega o caminho. */
function ajudaDoGrupo(): string {
  return [
    '⚽ Eu cuido da lista do racha.',
    '',
    'Aqui no grupo eu publico a lista às 19:00 e quando alguém sai.',
    'Digite "lista" para ver a atual.',
    '',
    'Para entrar ou sair, é só tocar na enquete do racha aqui no grupo.',
    'São 18 vagas de linha; passou disso, entra na reserva e sobe se alguém sair.',
    'Convidado (1 por pessoa, a partir de quinta 12:00) entra na mesma fila.',
    comoFalarComOBot(),
  ].join('\n');
}

async function tratarNoGrupo(entrada: Contexto): Promise<void> {
  const intencao = parse(entrada.texto);
  if (!intencao || !LEITURA_NO_GRUPO.has(intencao.tipo)) return;

  // Sem resolver identidade: leitura pura nao precisa saber quem perguntou, e
  // assim a conversa do grupo nao gera escrita no banco.
  const mandar = (texto: string) =>
    sendText(config.GROUP_JID, texto).catch((err) =>
      entrada.log.warn({ err }, 'falha ao responder no grupo'),
    );

  // Ajuda vale mesmo sem racha aberto: e justamente quando alguem novo aparece.
  if (intencao.tipo === 'ajuda') {
    await mandar(ajudaDoGrupo());
    return;
  }

  // Leitura usa a partida mais recente, inclusive fechada: depois do sabado
  // 09:00 ainda faz sentido consultar quem estava escalado.
  const partida = await partidaParaLeitura();
  if (!partida) return; // Nenhum racha jamais criado: silencio.

  const [itens, goleiros] = await Promise.all([
    listar(partida.id),
    listarGoleiros(partida.id),
  ]);
  await mandar(formatarLista(partida, itens, goleiros, config.RACHA_NOME));
}

/**
 * Depois de QUALQUER interacao no privado - nao so de quem confirmou como
 * fixo -, oferece a chance de convocar goleiro, se ainda faltar algum.
 *
 * Uma vez por pessoa por partida (`jaOfertadoGoleiro`/`goleiro_oferta`): sem
 * esse marcador a pergunta repetiria a cada mensagem enquanto o goleiro nao
 * completasse, e falta de goleiro costuma durar dias (mesmo cuidado que
 * `alertasDeVagas`, em domain/lista.ts, ja toma pra lista publicada no
 * grupo).
 *
 * Reconfere `conversa.carregar` depois do processamento normal: se a propria
 * mensagem acabou de abrir outro dialogo (convidado, goleiro por nome,
 * convidado orfao...), essa pergunta ficaria pro proximo turno - abrir por
 * cima derrubaria a resposta que a pessoa esta dando.
 */
async function ofertarGoleiroSeNecessario(
  ctx: Sessao,
  partida: Partida,
): Promise<void> {
  if (!listaAberta(partida)) return;

  const goleiros = await listarGoleiros(partida.id);
  if (goleiros.length >= partida.vagas_goleiro) return;

  if (await jaOfertadoGoleiro(ctx.jogadorId, partida.id)) return;
  if (await conversa.carregar(ctx.jogadorId)) return;

  await marcarOfertaGoleiro(ctx.jogadorId, partida.id);

  const faltam = partida.vagas_goleiro - goleiros.length;
  const pergunta = [
    `🧤 Ainda ${faltam === 1 ? 'falta 1 goleiro' : `faltam ${faltam} goleiros`} pro racha de ${rotuloData(partida.data_jogo)}. Você consegue algum?`,
    'Manda o nome (ou os dois, separados por vírgula), ou responda "não".',
  ].join('\n');
  await conversa.salvar(ctx.jogadorId, partida.id, 'aguardando_nomes_goleiro', {
    pergunta,
  });
  await noPrivado(ctx, pergunta);
}

export async function tratarMensagem(entrada: Contexto): Promise<void> {
  const resultado = await processarPrivado(entrada);
  if (resultado) await ofertarGoleiroSeNecessario(resultado.ctx, resultado.partida);
}

async function processarPrivado(
  entrada: Contexto,
): Promise<{ ctx: Sessao; partida: Partida } | undefined> {
  // O grupo e mural: anuncios do bot, conversa livre das pessoas, e so o
  // "lista" como exceção de leitura.
  if (entrada.origem === 'grupo') {
    await tratarNoGrupo(entrada);
    return undefined;
  }

  // Porta de entrada: o bot so conversa com quem e do grupo.
  //
  // Vale para TUDO, inclusive "ajuda" e "vou". O numero do bot nao e uma linha
  // dedicada - gente de fora escreve para ele achando que fala com o dono, e
  // essas pessoas nao tem nada a ver com o racha.
  //
  // Checado antes de resolver a identidade: quem nao e do grupo nem chega a
  // virar cadastro no banco.
  if (!(await ehMembro(entrada.log, entrada))) {
    entrada.log.info(
      { telefone: entrada.telefone, texto: entrada.texto.slice(0, 40) },
      'mensagem de quem nao e membro do grupo, ignorando',
    );
    return undefined;
  }

  // Une @lid e telefone num unico jogador. Sem isso, a mesma pessoa vira dois
  // cadastros: um pelo grupo e outro pelo privado.
  const jogador = await resolver({
    lid: entrada.lid,
    telefone: entrada.telefone,
    nome: entrada.nome,
    noPrivado: entrada.origem === 'privado',
  });
  const ctx: Sessao = {
    ...entrada,
    jogadorId: jogador.id,
    nomeNaLista: jogador.nome,
    falouNoPrivado: jogador.falouNoPrivado,
    naoPerturbe: jogador.naoPerturbe,
  };

  const intencao: Intencao | undefined = parse(ctx.texto);

  // Antes de qualquer coisa que dependa de racha aberto: a preferencia de
  // silencio tem que valer mesmo sem partida em andamento (ex.: fora da
  // janela semanal, entre o sabado e a proxima quarta).
  if (intencao?.tipo === 'nao_perturbe') {
    await definirNaoPerturbe(ctx.jogadorId, true);
    await noPrivado(
      ctx,
      'Combinado — não te chamo mais por conta própria. Se eu perguntar algo e você não responder, ok. "pode chamar" religa quando quiser.',
    );
    return undefined;
  }
  if (intencao?.tipo === 'pode_chamar') {
    await definirNaoPerturbe(ctx.jogadorId, false);
    await noPrivado(ctx, 'Beleza, volto a te chamar quando precisar.');
    return undefined;
  }

  const partida = await partidaAtual();
  if (!partida) {
    if (intencao) {
      const status = proximaAberturaFixos(new Date());
      const texto =
        status.tipo === 'a_qualquer_momento'
          ? 'A lista deve abrir a qualquer momento — se não abrir em alguns minutos, me chama de novo.'
          : `Ainda não abriu. Abre ${rotuloData(isoDate(status.data))} ao meio-dia, pros fixos.`;
      await noPrivado(ctx, texto);
    }
    return undefined;
  }

  // Comando de admin ANTES do dialogo em andamento: e um comando forte, como
  // "lista". Sem isso, um "admin add Fulano" mandado no meio de uma pergunta
  // do bot ("quem e o goleiro?") viraria resposta daquela pergunta - e o
  // Fulano entraria como convidado goleiro do proprio admin.
  //
  // O reconhecimento so acontece para o telefone autorizado: para qualquer
  // outra pessoa o texto segue o caminho normal (e cai no "nao entendi"),
  // sem revelar que o comando existe.
  const comandoAdmin = ehAdmin(ctx) ? parseAdmin(ctx.texto) : undefined;
  if (comandoAdmin) {
    await conversa.limpar(ctx.jogadorId);
    await tratarAdmin(ctx, partida, comandoAdmin);
    return { ctx, partida };
  }

  // Dialogo em andamento tem prioridade - "linha" so significa alguma coisa
  // depois de o bot perguntar. A excecao sao os comandos de verdade: sem isso,
  // quem responde "lista" no meio da pergunta ganharia um convidado chamado
  // "lista".
  {
    const conv = await conversa.carregar(ctx.jogadorId);
    if (conv) {
      if (!intencao || !COMANDOS_FORTES.has(intencao.tipo)) {
        // A conversa continua na partida em que comecou. Se a semana virar no
        // meio do dialogo, o convidado tem que entrar na lista certa.
        const daConversa =
          conv.partidaId === partida.id
            ? partida
            : ((await partidaPorId(conv.partidaId)) ?? partida);
        await continuarDialogo(ctx, conv, daConversa);
        return { ctx, partida };
      }
      await conversa.limpar(ctx.jogadorId);
    }
  }

  // No grupo, silencio: as pessoas conversam sobre outras coisas e o bot nao
  // pode responder a tudo. No privado, silencio so confunde - a pessoa esta
  // falando COM ele e merece saber o que vale.
  const semSignificadoSolto =
    !intencao ||
    intencao.tipo === 'afirmativa' ||
    intencao.tipo === 'negativa' ||
    intencao.tipo === 'numeros' ||
    intencao.tipo === 'todos';

  if (semSignificadoSolto) {
    // Antes de assumir "mensagem solta sem contexto", checa se nao e so
    // resposta atrasada a uma pergunta que caducou ha pouco - "nao entendi" +
    // menu inteiro faz parecer que o bot ignorou o nome que a pessoa mandou
    // (bug do Vinicius/Junior, 27/08/2026: respondeu 22min depois do TTL de
    // entao e achou que o bot nao tinha entendido).
    const expirada = await conversa.carregarExpiradaRecente(ctx.jogadorId);
    if (expirada) {
      // Nao "nao entendi" seco: reabre a MESMA pergunta do zero (ver
      // reiniciarPergunta) - a pessoa nao precisa saber que expirou nem
      // reformular do proprio punho.
      const daConversa =
        expirada.partidaId === partida.id
          ? partida
          : ((await partidaPorId(expirada.partidaId)) ?? partida);
      await reiniciarPergunta(ctx, daConversa, expirada);
      return { ctx, partida };
    }
    // Diferencia quem ja esta confirmado nesta partida (ex.: respondeu tarde
    // demais ate pra janela de graca de carregarExpiradaRecente, e a pergunta
    // original ja foi apagada - nao da pra reprisa-la) de quem nunca
    // confirmou: o primeiro so precisa saber que continua na lista, o
    // segundo precisa saber como entrar. Nenhum dos dois precisa de admin -
    // e tudo self-service.
    const inscricao = await minhaInscricao(partida.id, ctx.jogadorId);
    const abertura = inscricao
      ? `Não entendi "${ctx.texto.trim()}", mas você já está confirmado no racha de ${rotuloData(partida.data_jogo)} ✅.`
      : `Não entendi "${ctx.texto.trim()}". Você ainda não confirmou presença nesse racha — é só tocar em "✅ Vou" na enquete do grupo, ou me mandar "vou" aqui mesmo.`;
    await noPrivado(ctx, `${abertura}\n\n${AJUDA}`);
    return { ctx, partida };
  }

  if (intencao.tipo === 'ajuda') {
    await noPrivado(ctx, AJUDA);
    return { ctx, partida };
  }

  if (intencao.tipo === 'lista') {
    const [itens, goleiros] = await Promise.all([
      listar(partida.id),
      listarGoleiros(partida.id),
    ]);
    await noPrivado(ctx, formatarLista(partida, itens, goleiros, config.RACHA_NOME), {
      rodape: true,
    });
    return { ctx, partida };
  }

  if (!listaAberta(partida)) {
    await noPrivado(
      ctx,
      `A lista do racha de ${partida.data_jogo} não está aberta agora.`,
      { rodape: true },
    );
    return { ctx, partida };
  }

  switch (intencao.tipo) {
    case 'confirmar':
      await tratarConfirmar(ctx, partida);
      return { ctx, partida };
    case 'desistir':
      await tratarDesistir(ctx, partida);
      return { ctx, partida };
    case 'convidados':
      await tratarConvidados(ctx, partida, intencao.nomes);
      return { ctx, partida };
    case 'quero_convidar':
      await tratarQueroConvidar(ctx, partida);
      return { ctx, partida };
    case 'quero_goleiro':
      await tratarQueroGoleiro(ctx, partida, intencao.contratadoImplicito);
      return { ctx, partida };
    case 'tirar_convidado':
      await tratarTirarConvidado(ctx, partida, intencao.nome);
      return { ctx, partida };
    default:
      return { ctx, partida }; // posicao/negativa fora de dialogo: nao significam nada.
  }
}
