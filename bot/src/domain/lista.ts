import type { ItemGoleiro, ItemLista, Partida, Posicao } from './tipos.js';

// Tudo aqui e funcao pura: recebe os itens ja carregados e devolve texto.
// Sem banco e sem HTTP, o que torna o formato testavel com node --test.

export interface Vagas {
  /** Quantos estao DENTRO das vagas (nunca passa de `total`). */
  readonly ocupadas: number;
  readonly total: number;
  readonly livres: number;
  /** Quantos estao na fila de espera, alem das vagas. */
  readonly reservas: number;
}

/**
 * Conta so os jogadores de LINHA - goleiro tem teto e contagem propria
 * (`motivoRecusaGoleiro`, `listarGoleiros`) e nunca ocupa vaga da linha.
 *
 * A lista de linha aceita mais gente do que as vagas (decisao de 21/09/2026):
 * fixo nunca e recusado, so passa a ser RESERVA. Por isso `ocupadas` nao e
 * `itens.length` - ela para no teto, e o excedente vira `reservas`. Quem chama
 * para decidir se cabe mais alguem (convidado) continua olhando `livres`, que
 * e zero enquanto houver fila: a vaga que abrir e de quem esta esperando.
 */
export function contarVagas(
  itens: readonly ItemLista[],
  vagasTotal: number,
): Vagas {
  return {
    ocupadas: Math.min(itens.length, vagasTotal),
    total: vagasTotal,
    livres: Math.max(0, vagasTotal - itens.length),
    reservas: Math.max(0, itens.length - vagasTotal),
  };
}

/** Ha vaga para mais alguem? Com fila de espera, nao ha. */
export function cabeMais(vagas: Vagas): boolean {
  return vagas.livres > 0;
}

/**
 * Quem esta convocado e quem esta na fila, pela ordem de confirmacao.
 *
 * A ordem de chegada e o criterio: ela decide quem sao os 18 e quem sobe
 * quando alguem sai. Os itens ja chegam ordenados por `criado_em` do banco.
 */
export function separarFila(
  itens: readonly ItemLista[],
  vagasTotal: number,
): { convocados: readonly ItemLista[]; reserva: readonly ItemLista[] } {
  return {
    convocados: itens.slice(0, vagasTotal),
    reserva: itens.slice(vagasTotal),
  };
}

/**
 * Por que esse CONVIDADO nao pode entrar, se nao puder.
 *
 * Vale so para convidado: fixo entra sempre (vira reserva se as vagas ja
 * acabaram). `ocupadas` e o total de gente na linha, fila inclusa - e por isso
 * que um convidado e recusado enquanto houver reserva esperando: a proxima
 * vaga ja tem dono.
 */
export function motivoDaRecusa(
  ocupadas: number,
  partida: Pick<Partida, 'vagas_total'>,
  quantas: number,
): string | undefined {
  const livres = partida.vagas_total - ocupadas;
  if (quantas <= livres) return undefined;
  if (livres > 0) {
    return `Só resta${livres === 1 ? '' : 'm'} ${livres} vaga${livres === 1 ? '' : 's'}.`;
  }
  const naFila = ocupadas - partida.vagas_total;
  const completa = `A lista está completa (${partida.vagas_total} jogadores de linha).`;
  return naFila > 0
    ? `${completa} Tem ${naFila} ${naFila === 1 ? 'pessoa' : 'pessoas'} na reserva na frente — a próxima vaga é de quem está esperando.`
    : completa;
}

/** Por que um goleiro nao pode entrar, se nao puder. Teto proprio, sem fila. */
export function motivoRecusaGoleiro(
  ocupados: number,
  vagasGoleiro: number,
): string | undefined {
  if (ocupados < vagasGoleiro) return undefined;
  return vagasGoleiro === 1
    ? 'A vaga de goleiro já está ocupada.'
    : `As ${vagasGoleiro} vagas de goleiro já estão ocupadas.`;
}

const DIAS = [
  'domingo',
  'segunda',
  'terça',
  'quarta',
  'quinta',
  'sexta',
  'sábado',
] as const;

/** "2026-08-08" -> "sabado 08/08". Trata a data como calendario, sem fuso. */
export function rotuloData(dataJogo: string): string {
  const [ano, mes, dia] = dataJogo.split('-').map(Number);
  if (ano === undefined || mes === undefined || dia === undefined) {
    return dataJogo;
  }
  const d = new Date(ano, mes - 1, dia);
  const nome = DIAS[d.getDay()] ?? '';
  const dd = String(dia).padStart(2, '0');
  const mm = String(mes).padStart(2, '0');
  return `${nome} ${dd}/${mm}`;
}

function linhaItem(
  indice: number,
  item: ItemLista,
  anfitrioesPresentes: ReadonlySet<number>,
): string {
  // O anfitriao pode ter saido e o convidado ter ficado. Sem marcar isso, a
  // lista mostra "convidado de Fausto" com o Fausto fora dela, e quem le no
  // grupo nao entende.
  const anfitriaoSaiu =
    item.tipo === 'convidado' &&
    item.convidadoDeId !== undefined &&
    !anfitrioesPresentes.has(item.convidadoDeId);

  const origem =
    item.tipo === 'fixo'
      ? 'fixo'
      : anfitriaoSaiu
        ? `convidado (${item.convidadoDe ?? '?'} saiu)`
        : `convidado de ${item.convidadoDe ?? '?'}`;
  return `${String(indice).padStart(2, ' ')}. ${item.nome} — ${origem}`;
}

/**
 * "Fulano (contratado)" ou "Fulano (convidado de Alexson)".
 *
 * Mesmo cuidado que `linhaItem` com o anfitriao que saiu: o anfitriao de um
 * goleiro convidado e sempre um fixo de linha, entao `presentes` (calculado
 * so a partir dos itens de linha) ja cobre esse caso.
 */
function linhaGoleiro(g: ItemGoleiro, presentes: ReadonlySet<number>): string {
  if (g.contratado) return `${g.nome} (contratado)`;
  const anfitriaoSaiu =
    g.convidadoDeId !== undefined && !presentes.has(g.convidadoDeId);
  return anfitriaoSaiu
    ? `${g.nome} (convidado — ${g.convidadoDe ?? '?'} saiu)`
    : `${g.nome} (convidado de ${g.convidadoDe ?? '?'})`;
}

/**
 * Lista completa para mandar no grupo.
 *
 * Numeracao UNICA e em ordem de confirmacao (os itens ja chegam ordenados por
 * criado_em). Nao separar por linha/gol e proposital: o grupo usa a ordem para
 * saber quem chegou primeiro e quem chegou por ultimo, e duas numeracoes
 * paralelas destruiriam essa leitura.
 *
 * A RESERVA sai no mesmo texto, logo abaixo dos convocados e com a numeracao
 * continuando (19, 20...): e a mesma fila, so que a partir dali as pessoas
 * estao esperando vaga. Quem le precisa ver as duas coisas de uma vez - quem
 * joga sabado e quem entra se alguem cair.
 *
 * Goleiro e lista PROPRIA, a parte - nunca entra na numeracao nem no X/18.
 */
export function formatarLista(
  partida: Pick<Partida, 'data_jogo' | 'vagas_total'>,
  itens: readonly ItemLista[],
  goleiros: readonly ItemGoleiro[] = [],
  nomeDoRacha = 'Racha',
): string {
  const vagas = contarVagas(itens, partida.vagas_total);
  const { convocados, reserva } = separarFila(itens, partida.vagas_total);

  const partes: string[] = [
    `⚽ ${nomeDoRacha} — ${rotuloData(partida.data_jogo)} · ${vagas.ocupadas}/${vagas.total}${
      vagas.reservas ? ` (+${vagas.reservas} na reserva)` : ''
    }`,
    '',
  ];

  const presentes = new Set(
    itens
      .filter((i) => i.tipo === 'fixo' && i.jogadorId !== undefined)
      .map((i) => i.jogadorId as number),
  );

  partes.push(
    ...(convocados.length
      ? convocados.map((item, n) => linhaItem(n + 1, item, presentes))
      : ['  ninguém confirmou ainda']),
  );

  if (reserva.length) {
    partes.push(
      '',
      '🪑 Reserva (entra na ordem, se alguém sair):',
      ...reserva.map((item, n) =>
        linhaItem(partida.vagas_total + n + 1, item, presentes),
      ),
    );
  }

  partes.push(
    '',
    // Duas frases separadas, de proposito: "X/18 · goleiros por fora" numa
    // linha so deixava parecer que os goleiros contam dentro do X/18. Precisa
    // ficar claro que sao dois times diferentes de gente, ou membros com mais
    // dificuldade de leitura entendem que a lista inclui goleiro.
    `${vagas.ocupadas}/${vagas.total} de linha${
      vagas.reservas
        ? ` e ${vagas.reservas} na reserva`
        : ''
    }.`,
    goleiros.length
      ? `🧤 Goleiros: ${goleiros.map((g) => linhaGoleiro(g, presentes)).join(', ')}.`
      : '🧤 Goleiro: nenhum confirmado ainda.',
  );
  return partes.join('\n');
}

/**
 * Avisos que acompanham a lista quando a ocupacao muda.
 *
 * Funcao pura para poder ser testada sem banco nem WhatsApp - e para a
 * simulacao de alerta usar exatamente o mesmo codigo que roda de verdade.
 *
 * Nao inclui falta de goleiro de proposito: goleiro costuma chegar tarde na
 * semana, e um aviso por estado repetiria a mesma linha em toda mensagem por
 * dias. Isso e coberto quando um goleiro SAI e na chamada de sexta.
 */
export function alertasDeVagas(vagas: Vagas, limiar: number): string[] {
  if (vagas.livres === 0) {
    // Com fila, "lista completa" sozinho soaria como "nao adianta marcar" -
    // e adianta: quem marca agora fica na reserva e sobe se alguem cair.
    return vagas.reservas
      ? [
          `🔒 LISTA COMPLETA! ${vagas.ocupadas}/${vagas.total} na linha, ${vagas.reservas} na reserva.`,
        ]
      : [
          `🔒 LISTA COMPLETA! ${vagas.ocupadas}/${vagas.total} na linha.`,
          'Quem marcar a partir de agora entra na reserva.',
        ];
  }
  if (vagas.livres <= limiar) {
    return [
      `🔥 Corre! ${vagas.livres === 1 ? 'Última vaga' : `Últimas ${vagas.livres} vagas`}!`,
    ];
  }
  return [];
}
