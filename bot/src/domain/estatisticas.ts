import { query } from '../db.js';
import { normalizarNome } from './inscricao.js';

/** Regra do grupo: quem vem 3x como convidado vira fixo. */
export const PRESENCAS_PARA_VIRAR_FIXO = 3;

// O boletim publico do site (rachadoscansados.com.br/estatistica) precisa de
// numeros ja calculados, nunca do banco cru: o site e 100% estatico e nao
// tem como rodar SQL. Este modulo faz o calculo aqui, do lado do bot, e o
// resultado vira o JSON que `../estatisticas.ts` publica no repo do site.
//
// Separacao deliberada: as funcoes `buscar*` fazem IO (consultam o Postgres);
// `montarEstatisticas` e pura, recebe os dados ja buscados e so soma/agrupa -
// e a unica parte deste arquivo com teste unitario, ja que o resto exige um
// banco de verdade.

export interface EstatisticasPorRacha {
  data: string;
  fixos: number;
  convidados: number;
  goleiros: number;
  vagasLinha: number;
  totalLinha: number;
  notaMedia: number | null;
  totalNotas: number;
  votantesEnquete: number;
}

export interface PresencaJogador {
  nome: string;
  presencas: number;
  semanas: string[];
}

export interface Padrinho {
  nome: string;
  convidados: number;
}

export interface DistribuicaoNota {
  nota: number;
  quantidade: number;
}

export interface VolumeConvidado {
  nome: string;
  vezes: number;
  faltamParaFixo: number;
}

export interface Estatisticas {
  geradoEm: string;
  totalRachas: number;
  resumo: {
    rachasRealizados: number;
    taxaLotacaoLinha: number | null;
    jogadoresCadastrados: number;
    jogadoresQueJaJogaram: number;
    notaMediaGeral: number | null;
    totalAvaliacoes: number;
  };
  porRacha: EstatisticasPorRacha[];
  presenca: PresencaJogador[];
  padrinhos: Padrinho[];
  distribuicaoNotas: DistribuicaoNota[];
  volumeConvidados: VolumeConvidado[];
}

// ── Busca (IO) ───────────────────────────────────────────────────────────

interface LinhaComposicao {
  id: number;
  data_jogo: string;
  vagas_total: number;
  fixos: string;
  convidados: string;
  goleiros: string;
}

const SQL_COMPOSICAO = `
  select p.id, p.data_jogo, p.vagas_total,
         count(*) filter (where i.tipo = 'fixo' and i.posicao = 'linha') as fixos,
         count(*) filter (where i.tipo = 'convidado' and i.posicao = 'linha') as convidados,
         count(*) filter (where i.posicao = 'gol') as goleiros
    from partida p
    left join inscricao i on i.partida_id = p.id and i.removido_em is null
   where p.status = 'fechada'
   group by p.id, p.data_jogo, p.vagas_total
   order by p.data_jogo
`;

interface LinhaAvaliacao {
  partida_id: number;
  total_notas: string;
  nota_media: string | null;
}

const SQL_AVALIACAO_POR_PARTIDA = `
  select p.id as partida_id, count(a.nota) as total_notas, avg(a.nota) as nota_media
    from partida p
    left join avaliacao a on a.partida_id = p.id and a.nota is not null
   where p.status = 'fechada'
   group by p.id
`;

interface LinhaVotantes {
  partida_id: number;
  votantes: string;
}

const SQL_VOTANTES_POR_PARTIDA = `
  select v.partida_id, count(distinct v.jogador_id) as votantes
    from voto v
    join partida p on p.id = v.partida_id
   where p.status = 'fechada'
   group by v.partida_id
`;

interface LinhaPresenca {
  jogador_id: number;
  nome: string;
  data_jogo: string;
}

const SQL_PRESENCA = `
  select i.jogador_id, coalesce(j.nome_escolhido, j.nome) as nome, p.data_jogo
    from inscricao i
    join jogador j on j.id = i.jogador_id
    join partida p on p.id = i.partida_id
   where i.removido_em is null and i.tipo = 'fixo' and p.status = 'fechada'
   order by nome, p.data_jogo
`;

interface LinhaPadrinho {
  nome: string;
  convidados: string;
}

const SQL_PADRINHOS = `
  select coalesce(j.nome_escolhido, j.nome) as nome, count(*) as convidados
    from inscricao i
    join jogador j on j.id = i.convidado_de_id
    join partida p on p.id = i.partida_id
   where i.removido_em is null and i.tipo = 'convidado' and p.status = 'fechada'
   group by j.id, nome
   order by convidados desc, nome
`;

interface LinhaDistribuicao {
  nota: number;
  quantidade: string;
}

const SQL_DISTRIBUICAO_NOTAS = `
  select a.nota, count(*) as quantidade
    from avaliacao a
    join partida p on p.id = a.partida_id
   where a.nota is not null and p.status = 'fechada'
   group by a.nota
   order by a.nota
`;

interface LinhaAparicaoConvidado {
  convidado_nome: string;
  data_jogo: string;
}

// Convidado nao tem identidade rastreavel (so o nome digitado na hora, ver
// migration 012) - agrupar por nome normalizado e a unica forma de somar
// quantas vezes a mesma pessoa ja veio. Goleiro contratado por fora fica de
// fora: nao e um convidado a caminho de virar fixo, e alguem pago pontualmente.
const SQL_APARICOES_CONVIDADOS = `
  select i.convidado_nome, p.data_jogo
    from inscricao i
    join partida p on p.id = i.partida_id
   where i.removido_em is null
     and i.tipo = 'convidado'
     and i.goleiro_contratado = false
     and p.status = 'fechada'
   order by p.data_jogo
`;

export interface DadosBrutos {
  composicao: LinhaComposicao[];
  avaliacaoPorPartida: LinhaAvaliacao[];
  votantesPorPartida: LinhaVotantes[];
  presenca: LinhaPresenca[];
  padrinhos: LinhaPadrinho[];
  distribuicaoNotas: LinhaDistribuicao[];
  aparicoesConvidados: LinhaAparicaoConvidado[];
  jogadoresCadastrados: number;
}

export async function buscarDadosBrutos(): Promise<DadosBrutos> {
  const [
    composicao,
    avaliacaoPorPartida,
    votantesPorPartida,
    presenca,
    padrinhos,
    distribuicaoNotas,
    aparicoesConvidados,
    totalJogadores,
  ] = await Promise.all([
    query<LinhaComposicao>(SQL_COMPOSICAO),
    query<LinhaAvaliacao>(SQL_AVALIACAO_POR_PARTIDA),
    query<LinhaVotantes>(SQL_VOTANTES_POR_PARTIDA),
    query<LinhaPresenca>(SQL_PRESENCA),
    query<LinhaPadrinho>(SQL_PADRINHOS),
    query<LinhaDistribuicao>(SQL_DISTRIBUICAO_NOTAS),
    query<LinhaAparicaoConvidado>(SQL_APARICOES_CONVIDADOS),
    query<{ total: string }>('select count(*) as total from jogador'),
  ]);

  return {
    composicao,
    avaliacaoPorPartida,
    votantesPorPartida,
    presenca,
    padrinhos,
    distribuicaoNotas,
    aparicoesConvidados,
    jogadoresCadastrados: Number(totalJogadores[0]?.total ?? 0),
  };
}

// ── Montagem (pura) ─────────────────────────────────────────────────────

function arredondar(valor: number, casas = 2): number {
  const fator = 10 ** casas;
  return Math.round(valor * fator) / fator;
}

export function montarEstatisticas(
  dados: DadosBrutos,
  geradoEm: Date,
): Estatisticas {
  const avaliacaoPorId = new Map(
    dados.avaliacaoPorPartida.map((l) => [l.partida_id, l]),
  );
  const votantesPorId = new Map(
    dados.votantesPorPartida.map((l) => [l.partida_id, Number(l.votantes)]),
  );

  const porRacha: EstatisticasPorRacha[] = dados.composicao.map((l) => {
    const avaliacao = avaliacaoPorId.get(l.id);
    const totalNotas = Number(avaliacao?.total_notas ?? 0);
    const notaMedia =
      avaliacao?.nota_media != null ? arredondar(Number(avaliacao.nota_media)) : null;
    return {
      data: l.data_jogo,
      fixos: Number(l.fixos),
      convidados: Number(l.convidados),
      goleiros: Number(l.goleiros),
      vagasLinha: Number(l.vagas_total),
      totalLinha: Number(l.fixos) + Number(l.convidados),
      notaMedia,
      totalNotas,
      votantesEnquete: votantesPorId.get(l.id) ?? 0,
    };
  });

  const semanasLotadas = porRacha.filter(
    (r) => r.totalLinha >= r.vagasLinha,
  ).length;
  const taxaLotacaoLinha =
    porRacha.length > 0 ? arredondar(semanasLotadas / porRacha.length, 4) : null;

  const presencaPorJogador = new Map<number, { nome: string; semanas: string[] }>();
  for (const l of dados.presenca) {
    const atual = presencaPorJogador.get(l.jogador_id);
    if (atual) {
      atual.semanas.push(l.data_jogo);
    } else {
      presencaPorJogador.set(l.jogador_id, { nome: l.nome, semanas: [l.data_jogo] });
    }
  }
  const presenca: PresencaJogador[] = [...presencaPorJogador.values()]
    .map((j) => ({ nome: j.nome, presencas: j.semanas.length, semanas: j.semanas }))
    .sort((a, b) => b.presencas - a.presencas || a.nome.localeCompare(b.nome, 'pt-BR'));

  const padrinhos: Padrinho[] = dados.padrinhos.map((l) => ({
    nome: l.nome,
    convidados: Number(l.convidados),
  }));

  const distribuicaoNotas: DistribuicaoNota[] = dados.distribuicaoNotas.map((l) => ({
    nota: l.nota,
    quantidade: Number(l.quantidade),
  }));

  // Agrupa por nome normalizado (sem acento/caixa) - mesmo criterio usado em
  // `removerConvidado` para reconhecer o mesmo convidado entre partidas.
  const volumePorNome = new Map<string, { nome: string; vezes: number }>();
  for (const a of dados.aparicoesConvidados) {
    const chave = normalizarNome(a.convidado_nome);
    const atual = volumePorNome.get(chave);
    if (atual) {
      atual.vezes += 1;
    } else {
      volumePorNome.set(chave, { nome: a.convidado_nome, vezes: 1 });
    }
  }
  const volumeConvidados: VolumeConvidado[] = [...volumePorNome.values()]
    .map((v) => ({
      nome: v.nome,
      vezes: v.vezes,
      faltamParaFixo: Math.max(0, PRESENCAS_PARA_VIRAR_FIXO - v.vezes),
    }))
    .sort((a, b) => b.vezes - a.vezes || a.nome.localeCompare(b.nome, 'pt-BR'));

  const totalAvaliacoes = distribuicaoNotas.reduce((s, d) => s + d.quantidade, 0);
  const somaNotas = distribuicaoNotas.reduce((s, d) => s + d.nota * d.quantidade, 0);
  const notaMediaGeral =
    totalAvaliacoes > 0 ? arredondar(somaNotas / totalAvaliacoes) : null;

  return {
    geradoEm: geradoEm.toISOString(),
    totalRachas: porRacha.length,
    resumo: {
      rachasRealizados: porRacha.length,
      taxaLotacaoLinha,
      jogadoresCadastrados: dados.jogadoresCadastrados,
      jogadoresQueJaJogaram: presencaPorJogador.size,
      notaMediaGeral,
      totalAvaliacoes,
    },
    porRacha,
    presenca,
    padrinhos,
    distribuicaoNotas,
    volumeConvidados,
  };
}

export async function calcularEstatisticas(): Promise<Estatisticas> {
  const dados = await buscarDadosBrutos();
  return montarEstatisticas(dados, new Date());
}
