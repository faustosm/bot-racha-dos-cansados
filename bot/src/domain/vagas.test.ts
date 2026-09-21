import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  alertasDeVagas,
  cabeMais,
  contarVagas,
  formatarLista,
  motivoDaRecusa,
  separarFila,
} from './lista.js';
import type { ItemLista } from './tipos.js';

// Regressoes da revisao de 01/08/2026. Cada teste aqui existe porque o
// comportamento ja esteve errado.

const partida = { data_jogo: '2026-08-08', vagas_total: 18 };

const fixoSimples = (id: number): ItemLista => ({
  id,
  nome: `J${id}`,
  tipo: 'fixo',
  posicao: 'linha',
  jogadorId: id,
});

describe('convidado cujo anfitriao saiu', () => {
  it('e marcado na lista em vez de fingir que o anfitriao esta la', () => {
    const itens: ItemLista[] = [
      // O anfitriao (id 7) NAO esta na lista: saiu e o convidado ficou.
      {
        id: 2,
        nome: 'João',
        tipo: 'convidado',
        posicao: 'linha',
        convidadoDe: 'Fausto',
        convidadoDeId: 7,
      },
      { id: 3, nome: 'Ana', tipo: 'fixo', posicao: 'linha', jogadorId: 9 },
    ];
    const texto = formatarLista(partida, itens);
    assert.match(texto, /João — convidado \(Fausto saiu\)/);
  });

  it('com o anfitriao presente, mostra o vinculo normal', () => {
    const itens: ItemLista[] = [
      { id: 1, nome: 'Fausto', tipo: 'fixo', posicao: 'linha', jogadorId: 7 },
      {
        id: 2,
        nome: 'João',
        tipo: 'convidado',
        posicao: 'linha',
        convidadoDe: 'Fausto',
        convidadoDeId: 7,
      },
    ];
    const texto = formatarLista(partida, itens);
    assert.match(texto, /João — convidado de Fausto/);
    assert.doesNotMatch(texto, /saiu/);
  });
});

describe('alertasDeVagas', () => {
  const vagas = (ocupadas: number) =>
    contarVagas(Array.from({ length: ocupadas }, (_, i) => fixoSimples(i)), 18);

  it('anuncia lista completa aos 18 de linha, e que dali pra frente e reserva', () => {
    assert.deepEqual(alertasDeVagas(vagas(18), 2), [
      '🔒 LISTA COMPLETA! 18/18 na linha.',
      'Quem marcar a partir de agora entra na reserva.',
    ]);
  });

  it('com fila, diz quantos estao esperando em vez de convidar pra reserva', () => {
    assert.deepEqual(alertasDeVagas(vagas(21), 2), [
      '🔒 LISTA COMPLETA! 18/18 na linha, 3 na reserva.',
    ]);
  });

  it('avisa quando as vagas estao acabando', () => {
    assert.deepEqual(alertasDeVagas(vagas(16), 2), ['🔥 Corre! Últimas 2 vagas!']);
    assert.deepEqual(alertasDeVagas(vagas(17), 2), ['🔥 Corre! Última vaga!']);
  });

  it('fica calado com folga', () => {
    assert.deepEqual(alertasDeVagas(vagas(10), 2), []);
  });
});

// Fila de espera (21/09/2026): fixo nunca e recusado - passando das vagas ele
// vira reserva, e a proxima vaga que abrir e dele, nao de um convidado novo.
describe('fila de reserva', () => {
  const itens = (quantos: number) =>
    Array.from({ length: quantos }, (_, i) => fixoSimples(i + 1));

  it('conta os excedentes como reserva, sem estourar as vagas', () => {
    const v = contarVagas(itens(21), 18);
    assert.equal(v.ocupadas, 18);
    assert.equal(v.reservas, 3);
    assert.equal(v.livres, 0);
  });

  it('com fila nao cabe convidado: a vaga que abrir e de quem espera', () => {
    assert.equal(cabeMais(contarVagas(itens(19), 18)), false);
    assert.equal(cabeMais(contarVagas(itens(17), 18)), true);
  });

  it('separa convocados e reserva pela ordem de confirmacao', () => {
    const { convocados, reserva } = separarFila(itens(20), 18);
    assert.equal(convocados.length, 18);
    assert.deepEqual(
      reserva.map((i) => i.nome),
      ['J19', 'J20'],
    );
  });

  it('mostra a reserva no mesmo texto, com a numeracao continuando', () => {
    const texto = formatarLista(partida, itens(20));
    assert.match(texto, /· 18\/18 \(\+2 na reserva\)/);
    assert.match(texto, /🪑 Reserva \(entra na ordem, se alguém sair\):/);
    assert.match(texto, /19\. J19 — fixo/);
    assert.match(texto, /18\/18 de linha e 2 na reserva\./);
  });

  it('sem fila, nao inventa secao de reserva', () => {
    const texto = formatarLista(partida, itens(12));
    assert.doesNotMatch(texto, /reserva/i);
  });
});

describe('motivoDaRecusa', () => {
  const p = { vagas_total: 18 };

  it('com gente na reserva, explica que a vaga ja tem dono', () => {
    const m = motivoDaRecusa(20, p, 1) ?? '';
    assert.match(m, /2 pessoas na reserva/);
    assert.match(m, /próxima vaga é de quem está esperando/);
  });

  it('lista cheia recusa e diz que sao 18 de linha', () => {
    const m = motivoDaRecusa(18, p, 1);
    assert.match(m ?? '', /lista está completa/i);
    assert.match(m ?? '', /18 jogadores de linha/i);
    // Recusa de linha e sobre linha: nao pode confundir com o teto de gol,
    // que e separado (motivoRecusaGoleiro).
    assert.doesNotMatch(m ?? '', /goleiro/i);
  });

  it('com folga nao recusa ninguem', () => {
    assert.equal(motivoDaRecusa(5, p, 1), undefined);
  });

  it('recusa quando faltam vagas para todos os convidados', () => {
    assert.match(motivoDaRecusa(17, p, 2) ?? '', /Só resta 1 vaga/i);
  });
});

describe('remoção de convidado por nome', () => {
  // A comparação ignora acento e caixa: quem digita "joao" acha "João".
  // Sem isso, a pessoa erraria por causa do teclado do celular.
  it('normaliza acento e caixa ao comparar', () => {
    const iguais = (a: string, b: string) =>
      a.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim() ===
      b.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

    assert.ok(iguais('joao', 'João'));
    assert.ok(iguais('  JOÃO ', 'joão'));
    assert.ok(!iguais('João', 'João Silva'));
  });
});
