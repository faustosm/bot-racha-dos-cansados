import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isoDate, proximaAberturaFixos } from './datas.js';

// Semana de referencia: quarta 26/08/2026, sabado do jogo 29/08/2026.
const domingo = new Date(2026, 7, 23, 10);
const segunda = new Date(2026, 7, 24, 10);
const terca = new Date(2026, 7, 25, 10);
const quartaDeManha = new Date(2026, 7, 26, 9);
const quartaAoMeioDia = new Date(2026, 7, 26, 12);
const quartaDeTarde = new Date(2026, 7, 26, 15);
const quinta = new Date(2026, 7, 27, 10);
const sexta = new Date(2026, 7, 28, 10);
const sabadoDeManhaCedo = new Date(2026, 7, 29, 5);
const sabadoDepoisDoFecha = new Date(2026, 7, 29, 10);

const PROXIMA_QUARTA = '2026-08-26';
const QUARTA_SEGUINTE = '2026-09-02';

describe('proximaAberturaFixos', () => {
  it('domingo a terca: aponta pra quarta desta mesma semana', () => {
    for (const agora of [domingo, segunda, terca]) {
      const status = proximaAberturaFixos(agora);
      assert.equal(status.tipo, 'abre_em');
      assert.equal(
        status.tipo === 'abre_em' && isoDate(status.data),
        PROXIMA_QUARTA,
      );
    }
  });

  it('quarta antes do meio-dia: abre ainda hoje, as 12h', () => {
    const status = proximaAberturaFixos(quartaDeManha);
    assert.equal(status.tipo, 'abre_em');
    assert.equal(status.tipo === 'abre_em' && isoDate(status.data), PROXIMA_QUARTA);
    assert.equal(status.tipo === 'abre_em' && status.data.getHours(), 12);
  });

  it('quarta as 12h ou depois: deve abrir a qualquer momento', () => {
    assert.equal(proximaAberturaFixos(quartaAoMeioDia).tipo, 'a_qualquer_momento');
    assert.equal(proximaAberturaFixos(quartaDeTarde).tipo, 'a_qualquer_momento');
  });

  it('quinta e sexta: aponta pra quarta da semana seguinte', () => {
    for (const agora of [quinta, sexta]) {
      const status = proximaAberturaFixos(agora);
      assert.equal(status.tipo, 'abre_em');
      assert.equal(
        status.tipo === 'abre_em' && isoDate(status.data),
        QUARTA_SEGUINTE,
      );
    }
  });

  it('sabado, mesmo antes das 7h (fecha_em): ja aponta pra quarta seguinte', () => {
    const status = proximaAberturaFixos(sabadoDeManhaCedo);
    assert.equal(status.tipo, 'abre_em');
    assert.equal(status.tipo === 'abre_em' && isoDate(status.data), QUARTA_SEGUINTE);
  });

  it('sabado depois do fecha_em: a armadilha que proximoSabado cairia - ainda acerta a quarta seguinte', () => {
    const status = proximaAberturaFixos(sabadoDepoisDoFecha);
    assert.equal(status.tipo, 'abre_em');
    assert.equal(status.tipo === 'abre_em' && isoDate(status.data), QUARTA_SEGUINTE);
  });
});
