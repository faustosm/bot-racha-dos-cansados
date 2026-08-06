import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { alertasDeVagas, contarVagas, formatarLista } from './lista.js';
import type { ItemLista } from './tipos.js';

// Regressoes da revisao de 01/08/2026. Cada teste aqui existe porque o
// comportamento ja esteve errado.

const partida = { data_jogo: '2026-08-08', vagas_total: 20, vagas_goleiro: 2 };

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
  const vagas = (ocupadas: number, total: number) =>
    contarVagas(
      Array.from({ length: ocupadas }, (_, i) => fixoSimples(i)),
      total,
      2,
    );

  it('anuncia racha completo quando nao sobra vaga', () => {
    assert.deepEqual(alertasDeVagas(vagas(20, 20), 2), [
      '🔒 RACHA COMPLETO! 20/20',
    ]);
  });

  it('avisa quando as vagas estao acabando', () => {
    assert.deepEqual(alertasDeVagas(vagas(18, 20), 2), [
      '🔥 Corre! Ultimas 2 vagas!',
    ]);
    assert.deepEqual(alertasDeVagas(vagas(19, 20), 2), [
      '🔥 Corre! Ultima vaga!',
    ]);
  });

  it('fica calado com folga', () => {
    assert.deepEqual(alertasDeVagas(vagas(10, 20), 2), []);
  });

  it('completo tem prioridade sobre "acabando"', () => {
    // Com limiar 5 e 0 livres, as duas condicoes valem. So a mais forte sai.
    assert.deepEqual(alertasDeVagas(vagas(20, 20), 5), [
      '🔒 RACHA COMPLETO! 20/20',
    ]);
  });
});
