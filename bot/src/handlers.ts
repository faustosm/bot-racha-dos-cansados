import { config } from './config.js';
import { sendText } from './evolution/client.js';
import { normalizar, parse, separarNomes } from './commands/parse.js';
import type { Intencao } from './commands/parse.js';
import * as conversa from './conversa.js';
import {
  adicionarConvidado,
  confirmarFixo,
  desistir,
  listar,
  listarGoleiros,
  normalizarNome,
  removerConvidado,
  restaurarInscricao,
} from './domain/inscricao.js';
import { definirNaoPerturbe, resolver } from './domain/jogador.js';
import {
  avaliacaoAberta,
  convidadosLiberados,
  definirStatus,
  diaDeAvisarSaida,
  listaAberta,
  partidaAtual,
  partidaParaLeitura,
  partidaPorEnquete,
  partidaPorId,
} from './domain/partida.js';
import {
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
import type { Vagas } from './domain/lista.js';
import { alertasDeVagas, contarVagas, formatarLista } from './domain/lista.js';
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
  'tirar_convidado',
]);

const OPCOES_NOMES = [
  'Não entendi. Aqui eu espero uma destas coisas:',
  '',
  '  os nomes dos convidados, separados por vírgula',
  '    ex: Joao, Pedro',
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
  'A lista tem 18 vagas — todas de linha.',
  'Goleiro é contratado por fora ou convidado de um fixo, lista à parte.',
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
 * Precisa rodar em toda mudanca, publicando ou nao: e o status que faz o bot
 * recusar o 21o. Separado da publicacao porque o grupo so recebe mensagem fora
 * de horario em tres casos - alguem saiu, a lista acabou de lotar, ou um
 * convidado foi cadastrado (ver `registrarEntradaConvidado`).
 *
 * Devolve `lotouAgora` para quem chama saber se essa e uma das excecoes.
 */
async function sincronizarStatus(
  partida: Partida,
  itens: readonly ItemLista[],
): Promise<{ lotouAgora: boolean; vagas: Vagas }> {
  const vagas = contarVagas(itens, partida.vagas_total);

  // `definirStatus` so devolve true para quem REALMENTE mudou o status. Numa
  // corrida entre duas confirmacoes, uma so ganha - e so ela anuncia.
  const lotouAgora =
    vagas.livres === 0 ? await definirStatus(partida.id, 'cheia') : false;

  if (vagas.livres > 0) await definirStatus(partida.id, 'aberta');

  return { lotouAgora, vagas };
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
  const itens = await listar(partida.id);
  const goleiros = await listarGoleiros(partida.id);
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
 * Fica em silencio, exceto quando a lista acabou de lotar - aquela e a hora em
 * que o grupo precisa saber, senao gente continua tentando entrar. Confirmacao
 * de fixo nao merece mais que isso: sao dezenas por semana, e quem esta
 * olhando o grupo ja ve o proprio voto na enquete.
 */
async function registrarEntrada(
  ctx: Sessao,
  partida: Partida,
): Promise<void> {
  const itens = await listar(partida.id);
  const { lotouAgora } = await sincronizarStatus(partida, itens);
  if (!lotouAgora) return;

  // O cabecalho NAO repete "lista completa": `publicarLista` ja acrescenta o
  // alerta, e o rodape da lista tambem diz. Antes a mesma frase saia tres
  // vezes na mesma mensagem.
  await publicarLista(ctx, partida, `📣 ${ctx.nomeNaLista} fechou a lista!`);
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
 * So publica sexta ou sabado (decisao de 13/08/2026): e quando uma vaga
 * liberada ainda da tempo de repor alguem antes do jogo. Quarta/quinta fica
 * em silencio - o digest das 19:00 ja cobre, e sobra a semana inteira pra
 * reposicao.
 */
async function registrarSaida(
  ctx: Sessao,
  partida: Partida,
  cabecalho: string,
): Promise<void> {
  const itens = await listar(partida.id);
  await sincronizarStatus(partida, itens);
  if (!diaDeAvisarSaida()) return;
  await publicarLista(ctx, partida, cabecalho);
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
  await conversa.salvar(
    ctx.jogadorId,
    partida.id,
    'aguardando_posicao_convidados',
    { nomesPendentes: nomes },
  );
  await noPrivado(
    ctx,
    [
      'Todos de linha, ou tem goleiro entre eles?',
      'Se tiver, manda o nome de quem é goleiro. Se não, responda "linha".',
    ].join('\n'),
  );
}

/** Cadastra um lote de convidados de LINHA e resume o que entrou. */
async function registrarConvidadosLinha(
  ctx: Sessao,
  partida: Partida,
  nomes: readonly string[],
): Promise<void> {
  const entraram: string[] = [];
  for (const nome of nomes) {
    const r = await adicionarConvidado(partida, ctx.jogadorId, nome, 'linha');
    if (r.ok) entraram.push(nome);
    else await noPrivado(ctx, `${nome}: ${r.motivo}`);
  }
  if (!entraram.length) return;
  await noPrivado(ctx, `Anotado: ${entraram.join(', ')}.`, { rodape: true });

  const rotulo = entraram.length > 1 ? 'convidados' : 'convidado';
  await registrarEntradaConvidado(
    ctx,
    partida,
    `👥 ${ctx.nomeNaLista} confirmou ${rotulo}: ${entraram.join(', ')}!`,
  );
}

/** Pergunta se o proximo goleiro da fila e contratado ou convidado. */
async function perguntarTipoGoleiro(
  ctx: Sessao,
  partida: Partida,
  nome: string,
  filaRestante: readonly string[],
): Promise<void> {
  await conversa.salvar(ctx.jogadorId, partida.id, 'aguardando_tipo_goleiro', {
    filaGoleiros: [nome, ...filaRestante],
  });
  await noPrivado(
    ctx,
    `${nome} é contratado (por fora) ou é seu convidado mesmo?`,
  );
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
  const r = await adicionarConvidado(partida, ctx.jogadorId, nome, 'gol', {
    contratado,
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

  const [proximo, ...resto] = filaRestante;
  if (proximo) {
    await perguntarTipoGoleiro(ctx, partida, proximo, resto);
    return;
  }
  await conversa.limpar(ctx.jogadorId);
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
          'Boa! Agora manda os NOMES dos convidados.',
          'Exemplo: João, Pedro',
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

  await noPrivado(
    ctx,
    r.valor.jaEstava
      ? 'Você já estava na lista.'
      : `Confirmado como ${r.valor.posicao}. ✅`,
    { rodape: true },
  );

  // Ja estava na lista e nada mudou: republicar seria so ruido.
  if (r.valor.jaEstava) return;

  await registrarEntrada(ctx, partida);

  if (!r.valor.novo) return;

  // A pergunta sobre convidados so faz sentido depois de quinta 12:00.
  if (convidadosLiberados(partida)) {
    await conversa.salvar(ctx.jogadorId, partida.id, 'aguardando_nomes', {});
    await noPrivado(
      ctx,
      [
        'Vai levar convidado?',
        'Manda os nomes separados por vírgula (ex: João, Pedro),',
        'ou responda "não".',
      ].join('\n'),
    );
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
  await registrarSaida(ctx, partida, cabecalho);

  if (n === 0) return;

  // Saiu com convidados: eles podem ir mesmo sem quem os trouxe. Perguntar e
  // melhor do que decidir - a vaga e de alguem.
  const candidatos: conversa.Candidato[] = convidados.map((c, i) => ({
    indice: i + 1,
    nome: c.nome,
    posicao: c.posicao,
    inscricaoId: c.id,
  }));
  await conversa.salvar(ctx.jogadorId, partida.id, 'convidados_orfaos', {
    candidatos,
  });

  const numerada = candidatos
    .map(
      (c) => `${c.indice}. ${c.nome}`,
    )
    .join('\n');
  falarNoPrivado(
    [
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
      .join('\n'),
  );
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

  await conversa.salvar(ctx.jogadorId, partida.id, 'aguardando_nomes', {});
  await noPrivado(
    ctx,
    [
      'Boa! Quem você vai levar?',
      'Manda o nome. Se for mais de um, separe por vírgula:',
      '  João, Pedro',
      '',
      '("cancelar" se mudou de ideia)',
    ].join('\n'),
  );
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
  );
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

  v.log.info({ enqueteId: v.enqueteId }, 'voto de enquete desconhecida');
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

  const hashes = decifrarVoto(
    { encPayload: v.encPayload, encIv: v.encIv },
    {
      enqueteId: v.enqueteId,
      criadorJid: v.criadorJid,
      votanteJid: v.votanteLid,
      segredo: Uint8Array.from(Buffer.from(partida.enquete_segredo, 'base64')),
    },
  );
  if (!hashes) {
    v.log.warn({ enqueteId: v.enqueteId }, 'nao consegui decifrar o voto');
    return;
  }

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

  // Janela ANTES de resolver identidade: voto em partida fechada nao deve nem
  // criar cadastro de jogador.
  if (!listaAberta(partida)) {
    v.log.info({ partida: partida.data_jogo }, 'voto fora da janela, ignorado');
    return;
  }

  const jogador = await resolver({
    lid: v.votanteLid,
    telefone: v.votanteTelefone,
    nome: v.nome ?? v.votanteLid,
    // Votar no grupo NAO abre canal privado: quem so votou nunca escreveu.
    noPrivado: false,
  });

  const ctx: Sessao = {
    lid: v.votanteLid,
    ...(v.votanteTelefone ? { telefone: v.votanteTelefone } : {}),
    jidPrivado: v.votanteTelefone ?? v.votanteLid,
    nome: jogador.nome,
    texto: '',
    origem: 'grupo',
    log: v.log,
    jogadorId: jogador.id,
    nomeNaLista: jogador.nome,
    falouNoPrivado: jogador.falouNoPrivado,
    naoPerturbe: jogador.naoPerturbe,
  };

  const anterior = await votoAnterior(partida.id, ctx.jogadorId);
  v.log.info(
    { votante: ctx.nomeNaLista, opcao, anterior: anterior ?? null },
    'voto recebido',
  );

  // Mesma opcao de novo: reentrega do WhatsApp, ou a pessoa tocou duas vezes.
  // Anunciar seria repetir a mesma informacao no grupo.
  if (anterior === opcao) return;

  if (acao.tipo === 'desistir') {
    await tratarDesistir(ctx, partida, { origemVoto: true });
    await registrarVoto(partida.id, ctx.jogadorId, opcao);
    return;
  }

  const r = await confirmarFixo(partida, ctx.jogadorId, 'linha');
  if (!r.ok) {
    // Recusa (lista cheia) precisa aparecer: o voto ficou marcado na enquete e
    // a pessoa acharia que entrou.
    //
    // O voto NAO e registrado aqui de proposito: registrar uma tentativa que
    // falhou faria a proxima tentativa identica ser silenciada pelo dedupe, e
    // a pessoa nunca entraria quando abrisse vaga.
    await avisarGrupo(ctx, `⚠️ ${ctx.nomeNaLista}: ${r.motivo}`);
    return;
  }

  // Deu certo: agora sim o voto vira o "anterior" das proximas vezes.
  await registrarVoto(partida.id, ctx.jogadorId, opcao);

  const comConvidado = acao.tipo === 'confirmar_com_convidado';

  // O anuncio segue a OPCAO, nao o estado da lista. Trocar "Vou" por "Vou com
  // convidado" nao muda a vaga - `confirmarFixo` devolve "ja estava" - mas
  // muda o recado, e foi justamente isso que passou batido antes.
  //
  // O texto deixa o PENDENTE visivel: entre o voto e a resposta com o nome, o
  // convidado ainda nao existe na lista. Assim o proprio grupo cobra, sem o
  // bot precisar insistir no privado.
  // Confirmacao NAO interrompe o grupo: sao dezenas por semana e a lista sai
  // no digest das 19:00. So o "lotou agora" escapa daqui.
  await registrarEntrada(ctx, partida);

  if (!comConvidado) return;

  // Antes de quinta 12:00 a vaga de convidado nem existe. Avisa no privado e
  // nao abre conversa: quem quiser insiste votando de novo depois que abrir.
  if (!convidadosLiberados(partida)) {
    puxarConversa(
      ctx,
      '⏳ Convidado só a partir de quinta ao meio-dia. Vote de novo depois que abrir que eu te chamo.',
    );
    return;
  }

  // Unico ponto em que o bot puxa conversa. Vai pela fila (espacada) e respeita
  // quem pediu silencio - as duas protecoes vivem dentro de puxarConversa.
  await conversa.salvar(ctx.jogadorId, partida.id, 'aguardando_nomes', {});
  puxarConversa(
    ctx,
    [
      jogador.falouNoPrivado
        ? 'Você marcou na enquete que vai levar convidado 👥'
        : 'Oi! Eu cuido da lista do racha ⚽\nVocê marcou na enquete que vai levar convidado.',
      '',
      'Quem você vai levar? Manda o nome.',
      'Se for mais de um, separe por vírgula: João, Pedro',
      '',
      '("cancelar" se mudou de ideia)',
    ].join('\n'),
  );
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

  const hashes = decifrarVoto(
    { encPayload: v.encPayload, encIv: v.encIv },
    {
      enqueteId: v.enqueteId,
      criadorJid: v.criadorJid,
      votanteJid: v.votanteLid,
      segredo: Uint8Array.from(Buffer.from(convite.enquete_segredo, 'base64')),
    },
  );
  if (!hashes) {
    v.log.warn({ enqueteId: v.enqueteId }, 'nao consegui decifrar a avaliacao');
    return;
  }

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

  const itens = await listar(partida.id);
  const goleiros = await listarGoleiros(partida.id);
  await mandar(formatarLista(partida, itens, goleiros, config.RACHA_NOME));
}

export async function tratarMensagem(entrada: Contexto): Promise<void> {
  // O grupo e mural: anuncios do bot, conversa livre das pessoas, e so o
  // "lista" como exceção de leitura.
  if (entrada.origem === 'grupo') {
    await tratarNoGrupo(entrada);
    return;
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
    return;
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
    return;
  }
  if (intencao?.tipo === 'pode_chamar') {
    await definirNaoPerturbe(ctx.jogadorId, false);
    await noPrivado(ctx, 'Beleza, volto a te chamar quando precisar.');
    return;
  }

  const partida = await partidaAtual();
  if (!partida) {
    if (intencao) {
      await noPrivado(ctx, 'Nenhum racha aberto no momento.');
    }
    return;
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
        return;
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
    await noPrivado(ctx, `Não entendi "${ctx.texto.trim()}".\n\n${AJUDA}`);
    return;
  }

  if (intencao.tipo === 'ajuda') {
    await noPrivado(ctx, AJUDA);
    return;
  }

  if (intencao.tipo === 'lista') {
    const itens = await listar(partida.id);
    const goleiros = await listarGoleiros(partida.id);
    await noPrivado(ctx, formatarLista(partida, itens, goleiros, config.RACHA_NOME), {
      rodape: true,
    });
    return;
  }

  if (!listaAberta(partida)) {
    await noPrivado(
      ctx,
      `A lista do racha de ${partida.data_jogo} não está aberta agora.`,
      { rodape: true },
    );
    return;
  }

  switch (intencao.tipo) {
    case 'confirmar':
      await tratarConfirmar(ctx, partida);
      return;
    case 'desistir':
      await tratarDesistir(ctx, partida);
      return;
    case 'convidados':
      await tratarConvidados(ctx, partida, intencao.nomes);
      return;
    case 'quero_convidar':
      await tratarQueroConvidar(ctx, partida);
      return;
    case 'tirar_convidado':
      await tratarTirarConvidado(ctx, partida, intencao.nome);
      return;
    default:
      return; // posicao/negativa fora de dialogo: nao significam nada.
  }
}
