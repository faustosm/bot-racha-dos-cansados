import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { montarEstatisticas, type DadosBrutos } from './estatisticas.js';

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
  jogadoresCadastrados: 10,
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
      jogadoresCadastrados: 5,
    };
    const r = montarEstatisticas(vazio, new Date());
    assert.equal(r.resumo.taxaLotacaoLinha, null);
    assert.equal(r.resumo.notaMediaGeral, null);
    assert.equal(r.resumo.rachasRealizados, 0);
  });
});
