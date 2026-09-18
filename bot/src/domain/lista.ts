import type {
  ItemGoleiro,
  ItemLista,
  ItemReserva,
  Partida,
  Posicao,
} from './tipos.js';

// Tudo aqui e funcao pura: recebe os itens ja carregados e devolve texto.
// Sem banco e sem HTTP, o que torna o formato testavel com node --test.

export interface Vagas {
  readonly ocupadas: number;
  readonly total: number;
  readonly livres: number;
}

/**
 * Conta so os jogadores de LINHA - goleiro tem teto e contagem propria
 * (`motivoRecusaGoleiro`, `listarGoleiros`) e nunca ocupa vaga da linha.
 * A lista de linha fecha em 18.
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
 * Goleiro e lista PROPRIA, a parte - nunca entra na numeracao nem no X/18.
 */
export function formatarLista(
  partida: Pick<Partida, 'data_jogo' | 'vagas_total'>,
  itens: readonly ItemLista[],
  goleiros: readonly ItemGoleiro[] = [],
  nomeDoRacha = 'Racha',
  reservas: readonly ItemReserva[] = [],
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
      ? `🧤 Goleiros: ${goleiros.map((g) => linhaGoleiro(g, presentes)).join(', ')}.`
      : '🧤 Goleiro: nenhum confirmado ainda.',
  );

  // Reserva e a TERCEIRA lista, depois de linha e goleiro - numeracao propria
  // e fora do X/18, pelo mesmo motivo que o goleiro ficou de fora: quem le
  // precisa enxergar na hora que essa gente NAO esta na lista ainda.
  // Bloco ausente quando vazio: numa semana tranquila ele apareceria em todo
  // digest sem dizer nada.
  if (reservas.length) {
    partes.push(
      '',
      '🕒 Reservas (sobem automático se abrir vaga):',
      ...reservas.map(
        (r, n) =>
          `${String(n + 1).padStart(2, ' ')}. ${r.nome}${r.querConvidado ? ' (+1 convidado)' : ''}`,
      ),
    );
  }
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

/**
 * O que o bot responde a quem tocou em "Vou" com a lista cheia.
 *
 * Nao poe a pessoa na reserva sozinho: ela escolhe, tocando na opcao. O texto
 * existe para fazer a ponte - sem ele, o toque em "Vou" continuaria sendo um
 * beco sem saida, que e o problema que a reserva veio resolver.
 */
export function mensagemListaCheia(
  nome: string,
  vagas: Vagas,
  /**
   * O texto EXATO da opcao na enquete (`OPCAO_RESERVA`), passado de fora para
   * este modulo continuar puro - `enquete.ts` fala com o banco, e os testes
   * daqui rodam sem .env e sem Postgres.
   */
  opcaoReserva: string,
): string {
  return [
    `⚠️ ${nome}: a lista está completa (${vagas.ocupadas}/${vagas.total}). Quer ficar na reserva?`,
    `Toca em "${opcaoReserva}" na enquete que eu te chamo se abrir vaga.`,
  ].join('\n');
}

/**
 * Tocou em "Reserva" mas ainda ha vaga. Nao entra na reserva: ficar de fora
 * com vaga sobrando e o pior desfecho possivel, e e o que aconteceria se o
 * bot obedecesse ao toque. Manda de volta pro caminho normal.
 */
export function mensagemAindaTemVaga(nome: string, vagas: Vagas): string {
  return `⚠️ ${nome}: ainda tem vaga (${vagas.ocupadas}/${vagas.total})! Clica em "✅ Vou" que você entra direto.`;
}

/** Entrou na reserva. Uma linha no grupo, sem republicar a lista. */
export function mensagemEntrouNaReserva(nome: string, posicao: number): string {
  return `🕒 ${nome} entrou na reserva (${posicao}º). Se alguém sair, sobe automático.`;
}

/**
 * A linha que acompanha a saida quando alguem sobe.
 *
 * Vai junto do aviso de saida, nunca numa segunda mensagem: sao o mesmo
 * acontecimento, e duas mensagens seguidas dobram o ruido no grupo a cada
 * desistencia.
 */
export function mensagemSubiuDaReserva(nomes: readonly string[]): string {
  return nomes.length === 1
    ? `🔼 Subiu da reserva: ${nomes[0]}.`
    : `🔼 Subiram da reserva: ${nomes.join(', ')}.`;
}
