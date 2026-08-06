import { config } from './config.js';
import { sendText } from './evolution/client.js';
import { parse, separarNomes } from './commands/parse.js';
import type { Intencao } from './commands/parse.js';
import * as conversa from './conversa.js';
import {
  adicionarConvidado,
  confirmarFixo,
  desistir,
  listar,
  removerConvidado,
  restaurarInscricao,
} from './domain/inscricao.js';
import {
  confirmarNome,
  definirNaoPerturbe,
  definirNomeEscolhido,
  resolver,
} from './domain/jogador.js';
import {
  convidadosLiberados,
  definirStatus,
  listaAberta,
  partidaAtual,
  partidaParaLeitura,
  partidaPorEnquete,
  partidaPorId,
} from './domain/partida.js';
import { OPCOES, interpretar, registrarVoto } from './domain/enquete.js';
import { decifrarVoto, opcoesEscolhidas } from './domain/voto.js';
import {
  alertasDeVagas,
  contarVagas,
  convidadosDe,
  formatarConvidadosDe,
  formatarLista,
} from './domain/lista.js';
import type { Partida, Posicao } from './domain/tipos.js';
import { comoFalarComOBot } from './link.js';
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
  readonly nomeConfirmado: boolean;
  /** A pessoa ja escreveu para o bot alguma vez. */
  readonly falouNoPrivado: boolean;
  /** Pediu para o bot nao iniciar conversa. */
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
  'meus_convidados',
  'tirar',
  'quero_convidar',
  'nao_perturbe',
  'pode_perturbar',
]);

const OPCOES_NOMES = [
  'Nao entendi. Aqui eu espero uma destas coisas:',
  '',
  '  os nomes dos convidados, separados por virgula',
  '    ex: Joao, Pedro',
  '  "nao" (ou "nenhum") se nao for levar ninguem',
].join('\n');

/**
 * Rodape curto, anexado as respostas que ENCERRAM uma acao (confirmou, saiu,
 * lista). Nunca nas perguntas de dialogo: la a pessoa deve responder a pergunta,
 * e oferecer comandos no meio so confunde.
 *
 * Curto de proposito - lista completa em toda mensagem ninguem le.
 */
const RODAPE =
  '· vou · fora · vou levar convidado · quero tirar convidado · lista · ajuda ·';

// Escrito como frase, nao como sintaxe: o grupo e de gente comum, e "+nome"
// ja se provou incompreensivel na pratica.
const AJUDA = [
  'É só falar comigo normalmente. Por exemplo:',
  '',
  'ENTRAR',
  '  "vou"  ou  "bora"  ou  "tô dentro"',
  '  "vou de gol" — se for jogar no gol',
  '',
  'SAIR',
  '  "fora"  ou  "não vou"',
  '  (seus convidados saem junto)',
  '',
  'LEVAR CONVIDADO',
  '  "vou levar um convidado" — eu pergunto quem',
  '  "vou levar o João" — já anoto direto',
  '',
  'TIRAR CONVIDADO',
  '  "quero tirar um convidado" — eu mostro a lista e pergunto qual',
  '',
  'VER',
  '  "lista" — a lista completa',
  '  "meus" — só os seus convidados',
  '',
  'Tudo isso aqui no privado. No grupo eu só publico a lista;',
  'lá funcionam apenas "lista" e "ajuda".',
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
 * Usado num unico lugar: depois do voto em "Vou com convidado", para perguntar
 * o nome de quem vai junto. E o unico momento em que o bot escreve primeiro.
 */
function puxarConversa(ctx: Sessao, texto: string): void {
  if (ctx.naoPerturbe) {
    ctx.log.info(
      { jogadorId: ctx.jogadorId },
      'pediu para nao ser chamado, conversa nao iniciada',
    );
    return;
  }
  enfileirar(ctx.log, { para: ctx.jidPrivado, texto });
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
async function publicarLista(
  ctx: Sessao,
  partida: Partida,
  cabecalho: string,
): Promise<void> {
  const itens = await listar(partida.id);
  const vagas = contarVagas(itens, partida.vagas_total, partida.vagas_goleiro);

  // Mantem o status coerente com a ocupacao real.
  if (vagas.livres === 0 && partida.status !== 'cheia') {
    await definirStatus(partida.id, 'cheia');
  } else if (vagas.livres > 0 && partida.status === 'cheia') {
    await definirStatus(partida.id, 'aberta');
  }

  // Alertas vao JUNTO da lista, nao como mensagem separada. Como a lista so e
  // republicada quando algo muda, eles aparecem exatamente quando a contagem se
  // move - sem cron e sem repetir a toa.
  const alertas = alertasDeVagas(vagas, config.ALERTA_VAGAS);

  await avisarGrupo(
    ctx,
    [
      cabecalho,
      '',
      formatarLista(partida, itens, config.RACHA_NOME),
      ...(alertas.length ? ['', ...alertas] : []),
      '',
      // Repetido em toda publicacao de proposito: nunca se sabe se quem le e
      // alguem novo no grupo ou alguem que esqueceu como funciona.
      'Para entrar ou sair, responda na enquete lá em cima 👆',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Dialogo no privado
// ---------------------------------------------------------------------------

async function pedirPosicao(
  ctx: Sessao,
  partidaId: number,
  dados: conversa.DadosConversa,
): Promise<void> {
  const proximo = dados.pendentes?.[0];
  if (proximo === undefined) return;
  await conversa.salvar(ctx.jogadorId, partidaId, 'aguardando_posicao', dados);
  await noPrivado(
    ctx,
    `${proximo} joga de linha ou de gol?\nResponda: linha  ou  gol\n("cancelar" para desistir da pergunta)`,
  );
}

async function iniciarConvidados(
  ctx: Sessao,
  partida: Partida,
  nomes: readonly string[],
): Promise<void> {
  await pedirPosicao(ctx, partida.id, { pendentes: nomes, registrados: [] });
}

/** Encerra a rodada de convidados e resume o que entrou. */
async function fecharRodada(
  ctx: Sessao,
  partida: Partida,
  registrados: readonly { nome: string; posicao: Posicao }[],
): Promise<void> {
  await conversa.limpar(ctx.jogadorId);
  if (!registrados.length) return;

  const linhas = registrados.map(
    (r) => `  ${r.nome} (${r.posicao === 'gol' ? 'gol' : 'linha'})`,
  );
  await noPrivado(ctx, ['Anotado:', ...linhas].join('\n'), { rodape: true });

  const nomes = registrados.map((r) => r.nome).join(', ');
  await publicarLista(
    ctx,
    partida,
    `➕ ${ctx.nomeNaLista} trouxe ${registrados.length === 1 ? '1 convidado' : `${registrados.length} convidados`}: ${nomes}`,
  );
}

/**
 * Confere o nome antes de a pessoa aparecer na lista.
 *
 * O pushName do WhatsApp e o que a pessoa escolheu para o app: as vezes so o
 * primeiro nome, as vezes um apelido que ninguem do racha reconhece. Perguntar
 * uma unica vez evita lista cheia de "Ju", "Grandao" e afins.
 */
async function perguntarNome(ctx: Sessao, partida: Partida): Promise<void> {
  await conversa.salvar(ctx.jogadorId, partida.id, 'confirmando_nome', {});
  await noPrivado(
    ctx,
    [
      `Na lista voce vai aparecer como *${ctx.nomeNaLista}*.`,
      '',
      'Ta certo assim? (sim / nao)',
    ].join('\n'),
  );
}

async function pedirNomeCerto(ctx: Sessao, partida: Partida): Promise<void> {
  await conversa.salvar(ctx.jogadorId, partida.id, 'aguardando_nome', {});
  await noPrivado(
    ctx,
    [
      'Sem problema. Como voce quer aparecer na lista?',
      '',
      'Use o primeiro nome e o sobrenome, ou um apelido que o pessoal',
      'do racha reconheca. Por exemplo:',
      '  Fausto Soares',
      '  Fausto o craque',
    ].join('\n'),
  );
}

/** Depois de resolver o nome, segue para a pergunta de convidados. */
async function seguirDepoisDoNome(
  ctx: Sessao,
  partida: Partida,
): Promise<void> {
  await conversa.limpar(ctx.jogadorId);
  if (!convidadosLiberados(partida)) return;

  await conversa.salvar(ctx.jogadorId, partida.id, 'aguardando_nomes', {});
  await noPrivado(
    ctx,
    [
      'Vai levar convidado?',
      'Manda os nomes separados por virgula (ex: Joao, Pedro),',
      'ou responda "nao".',
    ].join('\n'),
  );
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
    await noPrivado(ctx, 'Ok, cancelei. Voce continua na lista.', {
      rodape: true,
    });
    return;
  }

  if (conv.estado === 'confirmando_nome') {
    if (intencao?.tipo === 'afirmativa') {
      await confirmarNome(ctx.jogadorId);
      await seguirDepoisDoNome(ctx, partida);
      return;
    }
    if (intencao?.tipo === 'negativa' || intencao?.tipo === 'desistir') {
      await pedirNomeCerto(ctx, partida);
      return;
    }
    await noPrivado(
      ctx,
      `Na lista voce aparece como *${ctx.nomeNaLista}*. Ta certo? Responda "sim" ou "nao".`,
    );
    return;
  }

  if (conv.estado === 'aguardando_nome') {
    const novo = ctx.texto.trim();

    // Sem isso, quem responde "fora" ou "lista" aqui fica cadastrado com esse
    // nome na lista do racha. O texto e livre, mas nao a esse ponto.
    if (intencao && intencao.tipo !== 'numeros') {
      await noPrivado(
        ctx,
        [
          `"${novo}" é um comando, não dá para usar como nome.`,
          '',
          'Como voce quer aparecer na lista? Por exemplo:',
          '  Fausto Soares',
          '  Fausto o craque',
        ].join('\n'),
      );
      return;
    }

    if (novo.length < 2 || novo.length > 40) {
      await noPrivado(
        ctx,
        'Nome muito curto ou muito longo. Manda entre 2 e 40 caracteres,\ncomo "Fausto Soares" ou "Fausto o craque".',
      );
      return;
    }
    await definirNomeEscolhido(ctx.jogadorId, novo);
    await noPrivado(ctx, `Feito! Agora voce aparece como *${novo}*.`);
    // A lista ja foi publicada com o nome antigo: republica para o grupo ver
    // quem e essa pessoa, senao o anuncio anterior fica orfao.
    await publicarLista(ctx, partida, `✏️ Agora com o nome certo: ${novo}`);
    await seguirDepoisDoNome({ ...ctx, nomeNaLista: novo }, partida);
    return;
  }

  if (conv.estado === 'aguardando_nomes') {
    if (intencao?.tipo === 'negativa') {
      await conversa.limpar(ctx.jogadorId);
        await noPrivado(
        ctx,
        'Beleza, sem convidados. Se mudar de ideia, e so falar "vou levar um convidado".',
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
          'Exemplo: Joao, Pedro',
          '',
          'Se desistir, responda "nao".',
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
          `Nao entendi "${ctx.texto.trim()}".`,
          '',
          numerada,
          '',
          candidatos.length === 1
            ? 'Ele vai mesmo assim? "sim" ou "nao".'
            : 'Responda o numero (ou "1, 2"), "todos", ou "nao".',
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
    await publicarLista(
      ctx,
      partida,
      `↩️ ${voltaram.join(', ')} vai${voltaram.length > 1 ? 'o' : ''} mesmo sem ${ctx.nomeNaLista}.`,
    );
    return;
  }

  if (conv.estado === 'confirmando_remocao') {
    const alvo = conv.dados.candidatos?.[0];
    if (!alvo) {
      await conversa.limpar(ctx.jogadorId);
      return;
    }
    if (intencao?.tipo === 'afirmativa') {
      await removerEscolhidos(ctx, partida, [alvo]);
      return;
    }
    if (intencao?.tipo === 'negativa' || intencao?.tipo === 'desistir') {
      await conversa.limpar(ctx.jogadorId);
      await noPrivado(ctx, 'Cancelado, ninguem foi tirado.', { rodape: true });
      return;
    }
    await noPrivado(ctx, `Tirar ${alvo.nome} da lista? Responda "sim" ou "nao".`);
    return;
  }

  if (conv.estado === 'aguardando_remocao') {
    const candidatos = conv.dados.candidatos ?? [];

    if (intencao?.tipo === 'negativa' || intencao?.tipo === 'desistir') {
      await conversa.limpar(ctx.jogadorId);
      await noPrivado(ctx, 'Cancelado, ninguem foi tirado.', { rodape: true });
      return;
    }
    if (intencao?.tipo === 'todos') {
      await removerEscolhidos(ctx, partida, candidatos);
      return;
    }
    if (intencao?.tipo === 'numeros') {
      const escolhidos = candidatos.filter((c) =>
        intencao.numeros.includes(c.indice),
      );
      if (!escolhidos.length) {
        await noPrivado(
          ctx,
          `Numero fora da lista. Escolha entre 1 e ${candidatos.length}.`,
        );
        return;
      }
      await removerEscolhidos(ctx, partida, escolhidos);
      return;
    }

    const numerada = candidatos
      .map((c) => `${c.indice}. ${c.nome}`)
      .join('\n');
    await noPrivado(
      ctx,
      [
        `Nao entendi "${ctx.texto.trim()}".`,
        '',
        numerada,
        '',
        'Responda o numero (ou "1, 2", ou "todos", ou "nao" para cancelar).',
      ].join('\n'),
    );
    return;
  }

  // aguardando_posicao
  if (intencao?.tipo !== 'posicao') {
    const proximo = conv.dados.pendentes?.[0] ?? 'o convidado';
    await noPrivado(
      ctx,
      [
        `Nao entendi "${ctx.texto.trim()}".`,
        '',
        `${proximo} joga de linha ou de gol?`,
        'Responda: linha  ou  gol',
      ].join('\n'),
    );
    return;
  }

  const pendentes = [...(conv.dados.pendentes ?? [])];
  const nome = pendentes.shift();
  if (nome === undefined) {
    await conversa.limpar(ctx.jogadorId);
    return;
  }

  const registrados = [...(conv.dados.registrados ?? [])];
  const r = await adicionarConvidado(
    partida,
    ctx.jogadorId,
    nome,
    intencao.posicao,
  );
  if (r.ok) {
    registrados.push({ nome, posicao: intencao.posicao });
  } else {
    await noPrivado(ctx, `${nome}: ${r.motivo}`);
  }

  if (pendentes.length) {
    await pedirPosicao(ctx, partida.id, { pendentes, registrados });
    return;
  }
  await fecharRodada(ctx, partida, registrados);
}

// ---------------------------------------------------------------------------
// Intencoes
// ---------------------------------------------------------------------------

async function tratarConfirmar(
  ctx: Sessao,
  partida: Partida,
  posicao: Posicao,
): Promise<void> {
  const r = await confirmarFixo(partida, ctx.jogadorId, posicao);
  if (!r.ok) {
    await noPrivado(ctx, r.motivo, { rodape: true });
    return;
  }

  await noPrivado(
    ctx,
    r.valor.jaEstava
      ? 'Voce ja estava na lista.'
      : `Confirmado como ${r.valor.posicao}. ✅`,
    { rodape: true },
  );

  // Ja estava na lista e nada mudou: republicar seria so ruido.
  if (r.valor.jaEstava) return;

  await publicarLista(
    ctx,
    partida,
    r.valor.novo
      ? `✅ ${ctx.nomeNaLista} confirmou (${r.valor.posicao === 'gol' ? 'gol' : 'linha'}).`
      : `🔄 ${ctx.nomeNaLista} agora vai de ${r.valor.posicao === 'gol' ? 'gol' : 'linha'}.`,
  );

  // Trocar de linha para gol nao e entrar na lista: nao repergunta o nome nem
  // abre a conversa de convidados de novo.
  if (!r.valor.novo) return;

  // Confere o nome UMA vez, antes de qualquer outra pergunta: e ele que vai
  // aparecer na lista do grupo daqui em diante.
  if (!ctx.nomeConfirmado) {
    await perguntarNome(ctx, partida);
    return;
  }

  // A pergunta sobre convidados so faz sentido depois de quinta 12:00.
  if (convidadosLiberados(partida)) {
    await conversa.salvar(ctx.jogadorId, partida.id, 'aguardando_nomes', {});
    await noPrivado(
      ctx,
      [
        'Vai levar convidado?',
        'Manda os nomes separados por virgula (ex: Joao, Pedro),',
        'ou responda "nao".',
      ].join('\n'),
    );
  }
}

async function tratarDesistir(ctx: Sessao, partida: Partida): Promise<void> {
  const r = await desistir(partida, ctx.jogadorId);
  if (!r.ok) {
    await noPrivado(ctx, r.motivo);
    return;
  }

  await conversa.limpar(ctx.jogadorId);

  const convidados = r.valor.convidados;
  const n = convidados.length;
  const extra = n > 0 ? ` (levou ${n} convidado${n > 1 ? 's' : ''} junto)` : '';

  // Goleiro saindo tem nome e sobrenome no anuncio: e a saida que mais
  // atrapalha, e o grupo precisa reagir a ela, nao so ler mais uma linha.
  const goleirosQueSairam = [
    ...(r.valor.posicao === 'gol' ? [ctx.nomeNaLista] : []),
    ...convidados.filter((c) => c.posicao === 'gol').map((c) => c.nome),
  ];

  const cabecalho = goleirosQueSairam.length
    ? [
        `🧤 ATENCAO: ${goleirosQueSairam.join(' e ')} era GOLEIRO e NAO vai mais!`,
        'Precisamos convocar outro goleiro.',
      ].join('\n')
    : `❌ ${ctx.nomeNaLista} NAO vai mais${extra}. Liberou vaga!`;

  await publicarLista(ctx, partida, cabecalho);

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
      (c) => `${c.indice}. ${c.nome} (${c.posicao === 'gol' ? 'gol' : 'linha'})`,
    )
    .join('\n');
  await noPrivado(
    ctx,
    [
      n === 1
        ? 'Seu convidado saiu junto:'
        : 'Seus convidados sairam junto:',
      numerada,
      '',
      n === 1
        ? 'Ele vai mesmo assim? Responda "sim" ou "nao".'
        : 'Algum deles vai mesmo assim?',
      n === 1
        ? ''
        : 'Responda o numero (ou "1, 2"), "todos", ou "nao" se nenhum vai.',
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
      'Convidados so a partir de quinta 12:00. Ate la a lista e dos fixos.',
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
      'Convidados so a partir de quinta 12:00. Ate la a lista e dos fixos.',
      { rodape: true },
    );
    return;
  }

  await conversa.salvar(ctx.jogadorId, partida.id, 'aguardando_nomes', {});
  await noPrivado(
    ctx,
    [
      'Boa! Quem voce vai levar?',
      'Manda o nome. Se for mais de um, separe por virgula:',
      '  Joao, Pedro',
      '',
      '("cancelar" se mudou de ideia)',
    ].join('\n'),
  );
}

/**
 * Tirar convidado e sempre uma conversa no PRIVADO, nunca uma acao direta.
 *
 * Duas razoes: a escolha por numero so faz sentido depois de ver a lista
 * numerada (senao e chute), e a negociacao de quem sai nao interessa ao grupo -
 * o que o grupo precisa saber e o resultado, que sai no anuncio.
 */
async function tratarTirar(
  ctx: Sessao,
  partida: Partida,
  indice: number | undefined,
): Promise<void> {
  const itens = await listar(partida.id);
  const meus = convidadosDe(itens, ctx.jogadorId);

  if (!meus.length) {
    await noPrivado(ctx, 'Voce nao tem convidados nesta lista.', {
      rodape: true,
    });
    return;
  }

  const candidatos: conversa.Candidato[] = meus.map((c, n) => ({
    indice: n + 1,
    nome: c.nome,
    posicao: c.posicao,
  }));

  const numerada = candidatos
    .map((c) => `${c.indice}. ${c.nome} (${c.posicao === 'gol' ? 'gol' : 'linha'})`)
    .join('\n');


  // Veio com numero: a pessoa escolheu, mas sem ter visto a lista. Confirma
  // mostrando quem e, para nao tirar o convidado errado por erro de contagem.
  if (indice !== undefined) {
    const alvo = candidatos.find((c) => c.indice === indice);
    if (!alvo) {
      await noPrivado(
        ctx,
        [`Voce tem ${candidatos.length} convidado(s):`, numerada, '', 'Qual voce quer tirar?'].join('\n'),
      );
      await conversa.salvar(ctx.jogadorId, partida.id, 'aguardando_remocao', {
        candidatos,
      });
      return;
    }
    await conversa.salvar(ctx.jogadorId, partida.id, 'confirmando_remocao', {
      candidatos: [alvo],
    });
    await noPrivado(ctx, `Tirar ${alvo.nome} da lista? (sim / nao)`);
    return;
  }

  await noPrivado(
    ctx,
    [
      'Seus convidados:',
      numerada,
      '',
      'Qual voce quer tirar? Responda o numero.',
      'Pode tirar mais de um: "1, 2". Ou "todos".',
      'Para cancelar, responda "nao".',
    ].join('\n'),
  );
  await conversa.salvar(ctx.jogadorId, partida.id, 'aguardando_remocao', {
    candidatos,
  });
}

/** Executa a remocao ja confirmada e anuncia o resultado no grupo. */
async function removerEscolhidos(
  ctx: Sessao,
  partida: Partida,
  escolhidos: readonly conversa.Candidato[],
): Promise<void> {
  await conversa.limpar(ctx.jogadorId);

  // De tras para frente: remover o 1o mudaria o indice dos seguintes.
  const ordenados = [...escolhidos].sort((a, b) => b.indice - a.indice);
  const removidos: string[] = [];
  for (const c of ordenados) {
    const r = await removerConvidado(partida, ctx.jogadorId, c.indice);
    if (r.ok) removidos.push(r.valor.nome);
    else await noPrivado(ctx, `${c.nome}: ${r.motivo}`);
  }
  if (!removidos.length) return;

  removidos.reverse();
  await noPrivado(ctx, `Tirei: ${removidos.join(', ')}.`, { rodape: true });

  const goleiros = ordenados
    .filter((c) => c.posicao === 'gol' && removidos.includes(c.nome))
    .map((c) => c.nome);

  await publicarLista(
    ctx,
    partida,
    goleiros.length
      ? [
          `🧤 ATENCAO: ${goleiros.join(' e ')} era GOLEIRO e NAO vai mais!`,
          'Precisamos convocar outro goleiro.',
        ].join('\n')
      : `❌ ${removidos.join(', ')} (convidado${removidos.length > 1 ? 's' : ''} de ${ctx.nomeNaLista}) NAO vai${removidos.length > 1 ? 'o' : ''} mais. Liberou vaga!`,
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
 * Um voto na enquete do grupo. E o caminho principal de confirmacao: um toque,
 * sem sair da conversa, sem o bot precisar escrever para ninguem.
 */
export async function tratarVoto(v: VotoRecebido): Promise<void> {
  if (!v.enqueteId || !v.criadorJid || !v.votanteLid) return;

  const partida = await partidaPorEnquete(v.enqueteId);
  if (!partida?.enquete_segredo) {
    v.log.info({ enqueteId: v.enqueteId }, 'voto de enquete desconhecida');
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
    nomeConfirmado: jogador.nomeConfirmado,
    falouNoPrivado: jogador.falouNoPrivado,
    naoPerturbe: jogador.naoPerturbe,
  };

  if (!listaAberta(partida)) {
    v.log.info({ partida: partida.data_jogo }, 'voto fora da janela, ignorado');
    return;
  }

  const anterior = await registrarVoto(partida.id, ctx.jogadorId, opcao);
  v.log.info(
    { votante: ctx.nomeNaLista, opcao, anterior: anterior ?? null },
    'voto recebido',
  );

  // Mesma opcao de novo: reentrega do WhatsApp, ou a pessoa tocou duas vezes.
  // Anunciar seria repetir a mesma informacao no grupo.
  if (anterior === opcao) return;

  if (acao.tipo === 'desistir') {
    await tratarDesistir(ctx, partida);
    return;
  }

  const r = await confirmarFixo(partida, ctx.jogadorId, 'linha');
  if (!r.ok) {
    // Recusa (lista cheia) precisa aparecer: o voto ficou marcado na enquete e
    // a pessoa acharia que entrou.
    await avisarGrupo(ctx, `⚠️ ${ctx.nomeNaLista}: ${r.motivo}`);
    return;
  }

  const comConvidado = acao.tipo === 'confirmar_com_convidado';

  // O anuncio segue a OPCAO, nao o estado da lista. Trocar "Vou" por "Vou com
  // convidado" nao muda a vaga - `confirmarFixo` devolve "ja estava" - mas
  // muda o recado, e foi justamente isso que passou batido antes.
  //
  // O texto deixa o PENDENTE visivel: entre o voto e a resposta com o nome, o
  // convidado ainda nao existe na lista. Assim o proprio grupo cobra, sem o
  // bot precisar insistir no privado.
  await publicarLista(
    ctx,
    partida,
    comConvidado
      ? `👥 ${ctx.nomeNaLista} marcou que vai e vai levar convidado — falta me mandar o nome.`
      : `✅ ${ctx.nomeNaLista} marcou que vai.`,
  );

  if (!comConvidado) return;

  // Antes de quinta 12:00 a vaga de convidado nem existe. Avisa e nao abre
  // conversa: quem quiser insiste votando de novo depois que abrir.
  if (!convidadosLiberados(partida)) {
    await avisarGrupo(
      ctx,
      `⏳ ${ctx.nomeNaLista}, convidado so a partir de quinta 12:00. Vote de novo depois que abrir que eu te chamo.`,
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
        ? 'Voce marcou na enquete que vai levar convidado 👥'
        : 'Oi! Eu cuido da lista do racha ⚽\nVoce marcou na enquete que vai levar convidado.',
      '',
      'Quem voce vai levar? Manda o nome.',
      'Se for mais de um, separe por virgula: Joao, Pedro',
      '',
      '("cancelar" se mudou de ideia)',
    ].join('\n'),
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
    'Aqui no grupo eu publico a lista a cada mudanca.',
    'Digite "lista" para ver a atual.',
    '',
    'Para confirmar presenca, sair ou levar convidado, fale comigo no privado:',
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
  await mandar(formatarLista(partida, itens, config.RACHA_NOME));
}

export async function tratarMensagem(entrada: Contexto): Promise<void> {
  // O grupo e mural: anuncios do bot, conversa livre das pessoas, e so o
  // "lista" como exceção de leitura.
  if (entrada.origem === 'grupo') {
    await tratarNoGrupo(entrada);
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
    nomeConfirmado: jogador.nomeConfirmado,
    falouNoPrivado: jogador.falouNoPrivado,
    naoPerturbe: jogador.naoPerturbe,
  };

  const partida = await partidaAtual();
  if (!partida) {
    const intencao = parse(ctx.texto);
    if (intencao) {
      await noPrivado(ctx, 'Nenhum racha aberto no momento.');
    }
    return;
  }

  const intencao: Intencao | undefined = parse(ctx.texto);

  // Dialogo em andamento tem prioridade - "linha" so significa alguma coisa
  // depois de o bot perguntar. A excecao sao os comandos de verdade: sem isso,
  // quem responde "lista" no meio da pergunta ganharia um convidado chamado
  // "lista".
  {
    const conv = await conversa.carregar(ctx.jogadorId);
    if (conv) {
      const nomeEmJogo =
        conv.estado === 'aguardando_nome' || conv.estado === 'confirmando_nome';
      if (nomeEmJogo || !intencao || !COMANDOS_FORTES.has(intencao.tipo)) {
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
    intencao.tipo === 'posicao' ||
    intencao.tipo === 'numeros' ||
    intencao.tipo === 'todos';

  if (semSignificadoSolto) {
    await noPrivado(ctx, `Nao entendi "${ctx.texto.trim()}".\n\n${AJUDA}`);
    return;
  }

  if (intencao.tipo === 'nao_perturbe') {
    await definirNaoPerturbe(ctx.jogadorId, true);
    await noPrivado(
      ctx,
      [
        'Beleza, nao te chamo mais 🤐',
        '',
        'Voce continua entrando na lista normalmente reagindo 👍 no grupo,',
        'e sempre que me escrever eu respondo.',
        '',
        'Para voltar a receber, e so mandar "pode me chamar".',
      ].join('\n'),
    );
    return;
  }

  if (intencao.tipo === 'pode_perturbar') {
    await definirNaoPerturbe(ctx.jogadorId, false);
    await noPrivado(ctx, 'Voltei a te chamar quando precisar 👍');
    return;
  }

  if (intencao.tipo === 'ajuda') {
    await noPrivado(ctx, AJUDA);
    return;
  }

  if (intencao.tipo === 'lista') {
    const itens = await listar(partida.id);
    await noPrivado(ctx, formatarLista(partida, itens, config.RACHA_NOME), { rodape: true });
    return;
  }

  if (intencao.tipo === 'meus_convidados') {
    const itens = await listar(partida.id);
    await noPrivado(ctx, formatarConvidadosDe(itens, ctx.jogadorId), {
      rodape: true,
    });
    return;
  }

  if (!listaAberta(partida)) {
    await noPrivado(
      ctx,
      `A lista do racha de ${partida.data_jogo} nao esta aberta agora.`,
      { rodape: true },
    );
    return;
  }

  switch (intencao.tipo) {
    case 'confirmar':
      await tratarConfirmar(ctx, partida, intencao.posicao);
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
    case 'tirar':
      await tratarTirar(ctx, partida, intencao.indice);
      return;
    default:
      return; // posicao/negativa fora de dialogo: nao significam nada.
  }
}
