import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aplicarConvocacoes, type ConfirmadoBot } from './merge.js';
import type { AppPlayer } from './client.js';

const player = (over: Partial<AppPlayer> & { id: string }): AppPlayer => ({
  phone: null,
  convocado: false,
  ...over,
});

const confirmado = (over: Partial<ConfirmadoBot> & { jogadorId: number }): ConfirmadoBot => ({
  nome: `jogador ${over.jogadorId}`,
  telefone: null,
  ...over,
});

describe('aplicarConvocacoes', () => {
  it('liga convocado de quem casa por telefone, sem tocar em outros campos', () => {
    const players = [
      player({ id: 'p1', name: 'Ana', phone: '+5534999999999', amount: 20 }),
      player({ id: 'p2', name: 'Bia', phone: '+5534988888888' }),
    ];
    const confirmados = [confirmado({ jogadorId: 1, telefone: '553499999999@s.whatsapp.net' })];

    const r = aplicarConvocacoes(players, confirmados);

    assert.equal(r.mudou, true);
    assert.equal(r.aplicados.length, 1);
    assert.equal(r.correspondidos.length, 1);
    assert.equal(r.semCorrespondencia.length, 0);
    const ana = r.players.find((p) => p.id === 'p1');
    assert.equal(ana?.convocado, true);
    assert.equal(ana?.amount, 20); // outros campos intactos
    const bia = r.players.find((p) => p.id === 'p2');
    assert.equal(bia?.convocado, false); // ninguem mais foi tocado
  });

  it('quem ja estava convocado nao conta como mudanca, mas conta como correspondido', () => {
    const players = [player({ id: 'p1', phone: '+5534999999999', convocado: true })];
    const confirmados = [confirmado({ jogadorId: 1, telefone: '553499999999@s.whatsapp.net' })];

    const r = aplicarConvocacoes(players, confirmados);

    assert.equal(r.mudou, false);
    assert.equal(r.aplicados.length, 0);
    assert.equal(r.correspondidos.length, 1);
    assert.equal(r.players, players); // mesma referencia, nada mudou
  });

  it('confirmado sem telefone correspondente no app cai em semCorrespondencia', () => {
    const players = [player({ id: 'p1', phone: '+5534999999999' })];
    const confirmados = [confirmado({ jogadorId: 1, nome: 'Zeca', telefone: '553488888888@s.whatsapp.net' })];

    const r = aplicarConvocacoes(players, confirmados);

    assert.equal(r.mudou, false);
    assert.deepEqual(r.semCorrespondencia, [{ jogadorId: 1, nome: 'Zeca' }]);
  });

  it('telefone duplicado entre dois players do app nao aplica em nenhum dos dois', () => {
    const players = [
      player({ id: 'p1', phone: '+5534999999999' }),
      player({ id: 'p2', phone: '553499999999@s.whatsapp.net' }),
    ];
    const confirmados = [confirmado({ jogadorId: 1, telefone: '553499999999@s.whatsapp.net' })];

    const r = aplicarConvocacoes(players, confirmados);

    assert.equal(r.mudou, false);
    assert.equal(r.correspondidos.length, 0);
    assert.equal(r.semCorrespondencia.length, 1);
  });

  it('acusa sobra so pra fixo convocado que nao confirmou, nunca desliga', () => {
    const players = [
      player({ id: 'p1', name: 'Ana', phone: '+5534999999999', category: 'fixo', convocado: true }),
      player({ id: 'p2', name: 'Bia', phone: '+5534988888888', category: 'fixo', convocado: true }),
      player({ id: 'p3', name: 'Goleiro', category: 'goleiro_pago', convocado: true }),
    ];
    // So Ana confirmou esta semana.
    const confirmados = [confirmado({ jogadorId: 1, telefone: '553499999999@s.whatsapp.net' })];

    const r = aplicarConvocacoes(players, confirmados);

    assert.deepEqual(r.possiveisSobras, [{ playerId: 'p2', nome: 'Bia' }]);
    for (const p of r.players) assert.notEqual(p.convocado, false); // so aviso, nunca desliga
  });

  it('nunca produz convocado=false em ninguem', () => {
    const players = [
      player({ id: 'p1', phone: '+5534999999999', convocado: true }),
      player({ id: 'p2', phone: '+5534988888888', convocado: true }),
    ];
    // Nenhum dos dois confirmou esta semana.
    const r = aplicarConvocacoes(players, []);

    assert.equal(r.mudou, false);
    for (const p of r.players) assert.notEqual(p.convocado, false);
  });
});
