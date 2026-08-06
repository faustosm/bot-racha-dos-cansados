import type { ItemLista, Partida, Posicao } from './tipos.js';

// Tudo aqui e funcao pura: recebe os itens ja carregados e devolve texto.
// Sem banco e sem HTTP, o que torna o formato testavel com node --test.

export interface Vagas {
  readonly ocupadas: number;
  readonly total: number;
  readonly livres: number;
  readonly gol: { readonly ocupadas: number; readonly livres: number };
  readonly linha: { readonly ocupadas: number };
}

export function contarVagas(
  itens: readonly ItemLista[],
  vagasTotal: number,
  vagasGoleiro: number,
): Vagas {
  const gol = itens.filter((i) => i.posicao === 'gol').length;
  const linha = itens.length - gol;
  return {
    ocupadas: itens.length,
    total: vagasTotal,
    livres: Math.max(0, vagasTotal - itens.length),
    gol: { ocupadas: gol, livres: Math.max(0, vagasGoleiro - gol) },
    linha: { ocupadas: linha },
  };
}

/**
 * Ha vaga para mais alguem nesta posicao?
 *
 * O teto de goleiros e maximo, nao cota reservada: com 1 goleiro inscrito,
 * as 19 vagas restantes podem ser todas de linha.
 */
export function cabeMais(
  vagas: Vagas,
  posicao: Posicao,
  vagasGoleiro: number,
): boolean {
  if (vagas.ocupadas >= vagas.total) return false;
  if (posicao === 'gol' && vagas.gol.ocupadas >= vagasGoleiro) return false;
  return true;
}

const DIAS = [
  'domingo',
  'segunda',
  'terca',
  'quarta',
  'quinta',
  'sexta',
  'sabado',
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
  const posicao = item.posicao === 'gol' ? 'gol 🧤' : 'linha';
  return `${String(indice).padStart(2, ' ')}. ${item.nome} — ${origem} · ${posicao}`;
}

/**
 * Lista completa para mandar no grupo.
 *
 * Numeracao UNICA e em ordem de confirmacao (os itens ja chegam ordenados por
 * criado_em). Nao separar por linha/gol e proposital: o grupo usa a ordem para
 * saber quem chegou primeiro e quem chegou por ultimo, e duas numeracoes
 * paralelas destruiriam essa leitura.
 */
export function formatarLista(
  partida: Pick<Partida, 'data_jogo' | 'vagas_total' | 'vagas_goleiro'>,
  itens: readonly ItemLista[],
  nomeDoRacha = 'Racha',
): string {
  const vagas = contarVagas(itens, partida.vagas_total, partida.vagas_goleiro);

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
      : ['  ninguem confirmou ainda']),
  );

  partes.push(
    '',
    `gol ${vagas.gol.ocupadas}/${partida.vagas_goleiro} · ${resumoVagas(vagas)}`,
  );
  return partes.join('\n');
}

export function resumoVagas(vagas: Vagas): string {
  if (vagas.livres === 0) return 'Lista completa 🔒';
  const plural = vagas.livres === 1 ? 'vaga' : 'vagas';
  const gol =
    vagas.gol.livres > 0
      ? ` (${vagas.gol.livres} de gol)`
      : ' (gol completo)';
  return `${vagas.livres} ${plural}${gol}`;
}

/** Convidados de um jogador, numerados — a referencia do comando "tirar N". */
export function formatarConvidadosDe(
  itens: readonly ItemLista[],
  jogadorId: number,
): string {
  const meus = itens.filter((i) => i.convidadoDeId === jogadorId);
  if (!meus.length) return 'Voce nao tem convidados nesta lista.';
  const linhas = meus.map(
    (i, n) => `${n + 1}. ${i.nome} (${i.posicao === 'gol' ? 'gol' : 'linha'})`,
  );
  return ['Seus convidados:', ...linhas].join('\n');
}

/** Os convidados de um jogador, na ordem que "tirar N" usa. */
export function convidadosDe(
  itens: readonly ItemLista[],
  jogadorId: number,
): readonly ItemLista[] {
  return itens.filter((i) => i.convidadoDeId === jogadorId);
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
    return [`🔒 RACHA COMPLETO! ${vagas.ocupadas}/${vagas.total}`];
  }
  if (vagas.livres <= limiar) {
    return [
      `🔥 Corre! ${vagas.livres === 1 ? 'Ultima vaga' : `Ultimas ${vagas.livres} vagas`}!`,
    ];
  }
  return [];
}
