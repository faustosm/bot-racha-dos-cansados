import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cabeMais, contarVagas, formatarLista, rotuloData } from './lista.js';
import { janelas, proximoSabado } from './datas.js';
import type { ItemLista } from './tipos.js';

const fixo = (id: number, nome: string, posicao: 'linha' | 'gol' = 'linha'): ItemLista => ({
  id,
  nome,
  tipo: 'fixo',
  posicao,
});

const convidado = (
  id: number,
  nome: string,
  de: string,
  posicao: 'linha' | 'gol' = 'linha',
): ItemLista => ({
  id,
  nome,
  tipo: 'convidado',
  posicao,
  convidadoDe: de,
  convidadoDeLid: `${de}@lid`,
});

describe('contarVagas', () => {
  it('separa linha e gol', () => {
    const v = contarVagas([fixo(1, 'A'), fixo(2, 'B', 'gol')], 20, 2);
    assert.equal(v.ocupadas, 2);
    assert.equal(v.livres, 18);
    assert.equal(v.gol.ocupadas, 1);
    assert.equal(v.gol.livres, 1);
    assert.equal(v.linha.ocupadas, 1);
  });
});

describe('cabeMais', () => {
  it('recusa quando a lista lotou', () => {
    const itens = Array.from({ length: 3 }, (_, i) => fixo(i, `J${i}`));
    const v = contarVagas(itens, 3, 2);
    assert.equal(cabeMais(v, 'linha', 2), false);
  });

  it('recusa o 3o goleiro mesmo com vaga de linha sobrando', () => {
    const itens = [fixo(1, 'A', 'gol'), fixo(2, 'B', 'gol')];
    const v = contarVagas(itens, 20, 2);
    assert.equal(cabeMais(v, 'gol', 2), false);
    assert.equal(cabeMais(v, 'linha', 2), true);
  });

  it('o teto de goleiro e maximo, nao cota reservada', () => {
    // 19 de linha + 1 goleiro = 20. A 2a vaga de gol nao fica guardada.
    const itens = [
      ...Array.from({ length: 19 }, (_, i) => fixo(i, `J${i}`)),
      fixo(99, 'Goleiro', 'gol'),
    ];
    const v = contarVagas(itens, 20, 2);
    assert.equal(v.ocupadas, 20);
    assert.equal(cabeMais(v, 'gol', 2), false);
  });
});

describe('formatarLista', () => {
  const partida = { data_jogo: '2026-08-08', vagas_total: 20, vagas_goleiro: 2 };

  it('mostra convidado com o nome de quem trouxe e a posicao', () => {
    const texto = formatarLista(partida, [
      fixo(1, 'Fausto'),
      convidado(2, 'João', 'Fausto'),
      convidado(3, 'Marcelo', 'Fausto', 'gol'),
    ]);
    assert.match(texto, /1\. Fausto — fixo · linha/);
    assert.match(texto, /2\. João — convidado de Fausto · linha/);
    assert.match(texto, /3\. Marcelo — convidado de Fausto · gol/);
    assert.match(texto, /gol 1\/2 · 17 vagas \(1 de gol\)/);
  });

  it('numera em ordem de confirmacao, sem separar por posicao', () => {
    // O grupo usa a ordem para saber quem chegou primeiro e por ultimo.
    // Um goleiro no meio nao pode reiniciar a contagem.
    const texto = formatarLista(partida, [
      fixo(1, 'Primeiro'),
      fixo(2, 'Segundo', 'gol'),
      fixo(3, 'Terceiro'),
    ]);
    assert.match(texto, /1\. Primeiro/);
    assert.match(texto, /2\. Segundo/);
    assert.match(texto, /3\. Terceiro/);
  });

  it('anuncia lista completa sem contagem de vagas', () => {
    const itens = Array.from({ length: 20 }, (_, i) => fixo(i, `J${i}`));
    assert.match(formatarLista(partida, itens), /Lista completa/);
  });

  it('nao quebra com a lista vazia', () => {
    assert.match(formatarLista(partida, []), /ninguem confirmou ainda/);
  });
});

describe('rotuloData', () => {
  it('traduz a data para dia da semana', () => {
    assert.equal(rotuloData('2026-08-08'), 'sabado 08/08');
  });
});

describe('proximoSabado', () => {
  it('devolve o proprio dia quando ja e sabado', () => {
    assert.equal(proximoSabado(new Date(2026, 7, 8, 10)), '2026-08-08');
  });

  it('a partir da quarta, aponta para o sabado seguinte', () => {
    assert.equal(proximoSabado(new Date(2026, 7, 5, 12)), '2026-08-08');
  });

  it('no domingo, aponta para o sabado da semana que vem', () => {
    assert.equal(proximoSabado(new Date(2026, 7, 9, 10)), '2026-08-15');
  });
});

describe('janelas', () => {
  it('quarta 12:00, quinta 12:00 e sabado 07:00', () => {
    const j = janelas('2026-08-08');
    assert.equal(j.abreFixos.getDay(), 3);
    assert.equal(j.abreFixos.getHours(), 12);
    assert.equal(j.abreConvidados.getDay(), 4);
    assert.equal(j.abreConvidados.getHours(), 12);
    assert.equal(j.fechaEm.getDay(), 6);
    // Fecha 2h antes do jogo (09:00), para dar tempo de completar o time.
    assert.equal(j.fechaEm.getHours(), 7);
  });
});
