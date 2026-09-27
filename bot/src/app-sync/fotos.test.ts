import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aplicarFotos, jidDoJogador } from './fotos-merge.js';

describe('aplicarFotos', () => {
  const players = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B', photo: 'data:image/jpeg;base64,velha' },
    { id: 'c', name: 'C', photo: 'data:image/jpeg;base64,igual' },
  ];

  it('poe, troca e tira foto; conta so o que mudou', () => {
    const r = aplicarFotos(players, new Map([
      ['a', 'data:image/jpeg;base64,nova'],
      ['b', null],
      ['c', 'data:image/jpeg;base64,igual'],
      ['sumiu', 'data:image/jpeg;base64,x'],
    ]));
    assert.equal(r.alterados, 2);
    assert.equal(r.players[0]?.photo, 'data:image/jpeg;base64,nova');
    assert.equal('photo' in (r.players[1] ?? {}), false);
    assert.equal(r.players[2], players[2]);
  });

  it('jogador fora das mudancas fica intacto', () => {
    const r = aplicarFotos(players, new Map());
    assert.equal(r.alterados, 0);
    assert.deepEqual(r.players, players);
  });
});

describe('jidDoJogador', () => {
  const doBot = new Map([['88887777', '553488887777@s.whatsapp.net']]);

  it('prefere o telefone que o bot ja conhece', () => {
    assert.equal(jidDoJogador('(34) 98888-7777', doBot), '553488887777@s.whatsapp.net');
  });
  it('monta a partir do app quando o bot nao conhece', () => {
    assert.equal(jidDoJogador('(34) 99111-2222', doBot), '5534991112222@s.whatsapp.net');
  });
  it('sem telefone utilizavel, nada', () => {
    assert.equal(jidDoJogador('12345678', doBot), undefined);
    assert.equal(jidDoJogador(null, doBot), undefined);
  });
});
