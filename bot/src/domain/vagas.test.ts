import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  alertasDeVagas,
  contarVagas,
  formatarLista,
  motivoDaRecusa,
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

  it('anuncia lista completa aos 18 de linha', () => {
    assert.deepEqual(alertasDeVagas(vagas(18), 2), [
      '🔒 LISTA COMPLETA! 18/18 na linha.',
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

describe('motivoDaRecusa', () => {
  const p = { vagas_total: 18 };

  it('lista cheia recusa e diz que sao 18 de linha', () => {
    const m = motivoDaRecusa(18, p, 1);
    assert.match(m ?? '', /lista está completa/i);
    assert.match(m ?? '', /18 jogadores de linha/i);
    // Goleiro saiu do bot: a recusa nao pode mandar procurar vaga de gol.
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
