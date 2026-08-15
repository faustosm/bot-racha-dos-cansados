import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cabeMais, contarVagas, formatarLista, rotuloData } from './lista.js';
import { janelaAvaliacao, janelas, proximoSabado } from './datas.js';
import type { ItemLista } from './tipos.js';

const fixo = (id: number, nome: string): ItemLista => ({
  id,
  nome,
  tipo: 'fixo',
  posicao: 'linha',
  jogadorId: id,
});

const convidado = (id: number, nome: string, de: string): ItemLista => ({
  id,
  nome,
  tipo: 'convidado',
  posicao: 'linha',
  convidadoDe: de,
  convidadoDeLid: `${de}@lid`,
});

describe('contarVagas', () => {
  it('conta so jogadores de linha', () => {
    // Os 2 goleiros sao contratados por fora e nao entram na lista.
    const v = contarVagas([fixo(1, 'A'), fixo(2, 'B')], 18);
    assert.equal(v.ocupadas, 2);
    assert.equal(v.livres, 16);
    assert.equal(v.total, 18);
  });
});

describe('cabeMais', () => {
  it('recusa quando a lista lotou em 18', () => {
    const itens = Array.from({ length: 18 }, (_, i) => fixo(i, `J${i}`));
    assert.equal(cabeMais(contarVagas(itens, 18)), false);
  });

  it('aceita enquanto houver vaga', () => {
    assert.equal(cabeMais(contarVagas([fixo(1, 'A')], 18)), true);
  });
});

describe('formatarLista', () => {
  const partida = { data_jogo: '2026-08-08', vagas_total: 18 };

  it('mostra convidado com o nome de quem trouxe e a posicao', () => {
    const texto = formatarLista(partida, [
      fixo(1, 'Fausto'),
      convidado(2, 'João', 'Fausto'),
      convidado(3, 'Marcelo', 'Fausto'),
    ]);
    assert.match(texto, /1\. Fausto — fixo/);
    assert.match(texto, /2\. João — convidado de Fausto/);
    assert.match(texto, /3\/18 de linha/);
  });

  it('numera em ordem de confirmacao, sem separar por posicao', () => {
    // O grupo usa a ordem para saber quem chegou primeiro e por ultimo.
    // Um goleiro no meio nao pode reiniciar a contagem.
    const texto = formatarLista(partida, [
      fixo(1, 'Primeiro'),
      fixo(2, 'Segundo'),
      fixo(3, 'Terceiro'),
    ]);
    assert.match(texto, /1\. Primeiro/);
    assert.match(texto, /2\. Segundo/);
    assert.match(texto, /3\. Terceiro/);
  });

  it('goleiro fica numa secao separada, fora do X/18', () => {
    // Regressao: "X/18 · goleiros por fora" numa linha so dava a entender
    // que os goleiros contavam dentro do X/18.
    const itens = Array.from({ length: 12 }, (_, i) => fixo(i, `J${i}`));
    const texto = formatarLista(partida, itens);
    assert.match(texto, /12\/18 de linha\./);
    assert.match(texto, /nenhum confirmado ainda/);
  });

  it('lista goleiro contratado e convidado, cada um com seu rotulo', () => {
    const itens = [fixo(1, 'Fausto')];
    const goleiros = [
      { id: 10, nome: 'Ricardo', contratado: true },
      { id: 11, nome: 'Marcos', contratado: false, convidadoDe: 'Fausto', convidadoDeId: 1 },
    ];
    const texto = formatarLista(partida, itens, goleiros);
    assert.match(texto, /🧤 Goleiros: Ricardo \(contratado\), Marcos \(convidado de Fausto\)\./);
  });

  it('goleiro convidado avisa quando o anfitriao saiu, igual convidado de linha', () => {
    // O anfitriao (id 7) NAO esta nos itens de linha: saiu e o goleiro ficou.
    const itens = [fixo(9, 'Ana')];
    const goleiros = [
      { id: 20, nome: 'Marcos', contratado: false, convidadoDe: 'Fausto', convidadoDeId: 7 },
    ];
    const texto = formatarLista(partida, itens, goleiros);
    assert.match(texto, /Marcos \(convidado — Fausto saiu\)/);
  });

  it('nao quebra com a lista vazia', () => {
    assert.match(formatarLista(partida, []), /ninguém confirmou ainda/);
  });
});

describe('rotuloData', () => {
  it('traduz a data para dia da semana', () => {
    assert.equal(rotuloData('2026-08-08'), 'sábado 08/08');
  });

  it('acentua os dias que precisam (sábado, terça)', () => {
    // Regressao: "sabado"/"terca" sem acento saiam em toda mensagem de
    // anuncio, digest e chamada de sexta.
    assert.equal(rotuloData('2026-08-11'), 'terça 11/08');
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
    // Encerra (avaliacao pos-jogo) sabado 12:00, depois do jogo acabar.
    assert.equal(j.encerraEm.getDay(), 6);
    assert.equal(j.encerraEm.getHours(), 12);
  });
});

describe('janelaAvaliacao', () => {
  it('aceita nota ate quarta 12:00 - mesmo horario em que a proxima partida abre pros fixos', () => {
    const prazo = janelaAvaliacao('2026-08-08');
    assert.equal(prazo.getDay(), 3);
    assert.equal(prazo.getHours(), 12);
    // 4 dias depois do sabado do jogo avaliado.
    assert.equal(prazo.getDate(), 12);
  });
});
