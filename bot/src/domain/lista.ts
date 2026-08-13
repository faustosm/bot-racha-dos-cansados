import type { ItemGoleiro, ItemLista, Partida, Posicao } from './tipos.js';

// Tudo aqui e funcao pura: recebe os itens ja carregados e devolve texto.
// Sem banco e sem HTTP, o que torna o formato testavel com node --test.

export interface Vagas {
  readonly ocupadas: number;
  readonly total: number;
  readonly livres: number;
}

/**
 * A lista e so de jogadores de linha.
 *
 * Os 2 goleiros sao contratados por fora e o bot nao os controla: nao ocupam
 * vaga, nao entram na contagem e nao aparecem na lista. A lista fecha em 18.
 */
export function contarVagas(
  itens: readonly ItemLista[],
  vagasTotal: number,
): Vagas {
  return {
    ocupadas: itens.length,
    total: vagasTotal,
    livres: Math.max(0, vagasTotal - itens.length),
  };
}

/** Ha vaga para mais alguem? */
export function cabeMais(vagas: Vagas): boolean {
  return vagas.livres > 0;
}

/** Por que essa pessoa nao pode entrar, se nao puder. */
export function motivoDaRecusa(
  ocupadas: number,
  partida: Pick<Partida, 'vagas_total'>,
  quantas: number,
): string | undefined {
  const livres = partida.vagas_total - ocupadas;
  if (quantas <= livres) return undefined;
  return livres <= 0
    ? `A lista está completa (${partida.vagas_total} jogadores de linha).`
    : `Só resta${livres === 1 ? '' : 'm'} ${livres} vaga${livres === 1 ? '' : 's'}.`;
}

/** Por que um goleiro nao pode entrar, se nao puder. Teto proprio, separado da linha. */
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

/** "Fulano (contratado)" ou "Fulano (convidado de Alexson)". */
function linhaGoleiro(g: ItemGoleiro): string {
  return `${g.nome} (${g.contratado ? 'contratado' : `convidado de ${g.convidadoDe ?? '?'}`})`;
}

/**
 * Lista completa para mandar no grupo.
 *
 * Numeracao UNICA e em ordem de confirmacao (os itens ja chegam ordenados por
 * criado_em). Nao separar por linha/gol e proposital: o grupo usa a ordem para
 * saber quem chegou primeiro e quem chegou por ultimo, e duas numeracoes
 * paralelas destruiriam essa leitura.
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

  const partes: string[] = [
    `⚽ ${nomeDoRacha} — ${rotuloData(partida.data_jogo)} · ${vagas.ocupadas}/${vagas.total}`,
    '',
  ];

  const presentes = new Set(
    itens
      .filter((i) => i.tipo === 'fixo' && i.jogadorId !== undefined)
      .map((i) => i.jogadorId as number),
  );

  partes.push(
    ...(itens.length
      ? itens.map((item, n) => linhaItem(n + 1, item, presentes))
      : ['  ninguém confirmou ainda']),
  );

  partes.push(
    '',
    // Duas frases separadas, de proposito: "X/18 · goleiros por fora" numa
    // linha so deixava parecer que os goleiros contam dentro do X/18. Precisa
    // ficar claro que sao dois times diferentes de gente, ou membros com mais
    // dificuldade de leitura entendem que a lista inclui goleiro.
    `${vagas.ocupadas}/${vagas.total} de linha.`,
    goleiros.length
      ? `🧤 Goleiros: ${goleiros.map(linhaGoleiro).join(', ')}.`
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
    return [`🔒 LISTA COMPLETA! ${vagas.ocupadas}/${vagas.total} na linha.`];
  }
  if (vagas.livres <= limiar) {
    return [
      `🔥 Corre! ${vagas.livres === 1 ? 'Última vaga' : `Últimas ${vagas.livres} vagas`}!`,
    ];
  }
  return [];
}
