import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mascararNome, montarEstatisticas, type DadosBrutos } from './estatisticas.js';

const dadosBase: DadosBrutos = {
  composicao: [
    { id: 1, data_jogo: '2026-08-15', vagas_total: 18, fixos: '16', convidados: '2', goleiros: '0' },
    { id: 2, data_jogo: '2026-08-22', vagas_total: 18, fixos: '17', convidados: '1', goleiros: '2' },
  ],
  avaliacaoPorPartida: [
    { partida_id: 1, total_notas: '16', nota_media: '4.5625' },
    { partida_id: 2, total_notas: '14', nota_media: '4.642857' },
  ],
  votantesPorPartida: [
    { partida_id: 1, votantes: '23' },
    { partida_id: 2, votantes: '3' },
  ],
  presenca: [
    { jogador_id: 1, nome: 'Ana', data_jogo: '2026-08-15' },
    { jogador_id: 1, nome: 'Ana', data_jogo: '2026-08-22' },
    { jogador_id: 2, nome: 'Bruno', data_jogo: '2026-08-15' },
  ],
  padrinhos: [{ nome: 'Ana', convidados: '2' }],
  distribuicaoNotas: [
    { nota: 4, quantidade: '9' },
    { nota: 5, quantidade: '21' },
  ],
  aparicoesConvidados: [
    { convidado_nome: 'Carlos', data_jogo: '2026-08-15', anfitriao: 'Ana' },
    { convidado_nome: 'carlos', data_jogo: '2026-08-22', anfitriao: 'Ana' },
    { convidado_nome: 'Carlos', data_jogo: '2026-08-15', anfitriao: 'Bruno' },
    { convidado_nome: 'Diego', data_jogo: '2026-08-15', anfitriao: 'Ana' },
  ],
  jogadoresCadastrados: 10,
  nuncaJogaram: [
    { nome: 'Elias', inscrito_agora: false },
    { nome: 'Fabio', inscrito_agora: true },
  ],
};

describe('montarEstatisticas', () => {
  it('calcula lotacao da linha por semana e a taxa geral', () => {
    const r = montarEstatisticas(dadosBase, new Date('2026-08-29T00:00:00Z'));
    assert.equal(r.porRacha[0]?.totalLinha, 18);
    assert.equal(r.porRacha[1]?.totalLinha, 18);
    // as duas semanas bateram vagasLinha (18) -> 100%
    assert.equal(r.resumo.taxaLotacaoLinha, 1);
  });

  it('agrupa presenca por jogador e ordena por quem jogou mais', () => {
    const r = montarEstatisticas(dadosBase, new Date());
    assert.deepEqual(
      r.presenca.map((p) => [p.nome, p.presencas]),
      [['Ana', 2], ['Bruno', 1]],
    );
    assert.deepEqual(r.presenca[0]?.semanas, ['2026-08-15', '2026-08-22']);
  });

  it('calcula a nota media geral a partir da distribuicao, nao da media das medias', () => {
    const r = montarEstatisticas(dadosBase, new Date());
    // (4*9 + 5*21) / 30 = 141/30 = 4.7
    assert.equal(r.resumo.notaMediaGeral, 4.7);
    assert.equal(r.resumo.totalAvaliacoes, 30);
  });

  it('conta jogadoresQueJaJogaram como jogadores distintos, nao linhas', () => {
    const r = montarEstatisticas(dadosBase, new Date());
    assert.equal(r.resumo.jogadoresQueJaJogaram, 2);
  });

  it('sem rachas fechados, nao quebra e devolve taxa/nota nulas', () => {
    const vazio: DadosBrutos = {
      composicao: [],
      avaliacaoPorPartida: [],
      votantesPorPartida: [],
      presenca: [],
      padrinhos: [],
      distribuicaoNotas: [],
      aparicoesConvidados: [],
      jogadoresCadastrados: 5,
      nuncaJogaram: [],
    };
    const r = montarEstatisticas(vazio, new Date());
    assert.equal(r.resumo.taxaLotacaoLinha, null);
    assert.equal(r.resumo.notaMediaGeral, null);
    assert.equal(r.resumo.rachasRealizados, 0);
  });

  it('agrupa volume de convidados por PAR (padrinho, nome normalizado), nao so pelo nome', () => {
    const r = montarEstatisticas(dadosBase, new Date());
    // Carlos trazido pela Ana 2x (nome normalizado casa "Carlos"/"carlos") vira
    // uma linha so; Carlos trazido pelo Bruno 1x e OUTRA linha - mesmo nome,
    // padrinho diferente, tratado como pessoa possivelmente diferente.
    assert.deepEqual(
      r.volumeConvidados.map((v) => [v.anfitriao, v.nome, v.vezes, v.faltamParaFixo]),
      [
        ['Ana', 'Carlos', 2, 1],
        ['Bruno', 'Carlos', 1, 2],
        ['Ana', 'Diego', 1, 2],
      ],
    );
  });

  it('quando ja bateu as 3 presencas, faltamParaFixo fica em zero (nao negativo)', () => {
    const dados: DadosBrutos = {
      ...dadosBase,
      aparicoesConvidados: [
        { convidado_nome: 'Elias', data_jogo: '2026-08-01', anfitriao: 'Ana' },
        { convidado_nome: 'Elias', data_jogo: '2026-08-08', anfitriao: 'Ana' },
        { convidado_nome: 'Elias', data_jogo: '2026-08-15', anfitriao: 'Ana' },
        { convidado_nome: 'Elias', data_jogo: '2026-08-22', anfitriao: 'Ana' },
      ],
    };
    const r = montarEstatisticas(dados, new Date());
    assert.deepEqual(r.volumeConvidados[0], {
      nome: 'Elias',
      anfitriao: 'Ana',
      vezes: 4,
      faltamParaFixo: 0,
    });
  });
});

// Quem nunca foi convocado nao aparecia em lugar nenhum das estatisticas:
// `presenca` so lista quem jogou, e o resumo dava so o numero. Sem a lista,
// "29 de 38 ja jogaram" nao dizia QUEM sao os outros 9 (22/09/2026).
describe('nuncaJogaram', () => {
  it('leva os cadastrados sem nenhuma convocacao, com o nome', () => {
    const r = montarEstatisticas(dadosBase, new Date());
    assert.deepEqual(
      r.nuncaJogaram.map((j) => j.nome),
      ['Elias', 'Fabio'],
    );
  });

  it('marca quem ja esta inscrito na partida em aberto', () => {
    const r = montarEstatisticas(dadosBase, new Date());
    assert.equal(r.nuncaJogaram[0]?.inscritoAgora, false);
    assert.equal(r.nuncaJogaram[1]?.inscritoAgora, true);
  });

  it('nao expoe telefone - o JSON e publico', () => {
    const r = montarEstatisticas(dadosBase, new Date());
    for (const j of r.nuncaJogaram) {
      assert.deepEqual(Object.keys(j).sort(), ['inscritoAgora', 'nome']);
    }
  });
});

// Quem nunca falou com o bot nao tem nome - o cadastro guarda o telefone no
// lugar. Esse numero nao pode vazar pro estatisticas.json, que e publico.
describe('mascararNome', () => {
  it('troca telefone por "sem nome" + 4 digitos', () => {
    assert.equal(mascararNome('551199990000'), 'sem nome · 0000');
  });

  it('nao mexe em nome de verdade', () => {
    assert.equal(mascararNome('Elias Lemes'), 'Elias Lemes');
    assert.equal(mascararNome('Markin🙏🏻⚽️⚽️'), 'Markin🙏🏻⚽️⚽️');
  });

  it('nao confunde nome curto com numero com nome', () => {
    // Apelido numerico improvavel, mas curto demais pra ser telefone.
    assert.equal(mascararNome('10'), '10');
  });

  it('mascara na lista publicada, nao so na funcao', () => {
    const r = montarEstatisticas(
      { ...dadosBase, nuncaJogaram: [{ nome: '551199991234', inscrito_agora: false }] },
      new Date(),
    );
    assert.equal(r.nuncaJogaram[0]?.nome, 'sem nome · 1234');
  });
});
