import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OPCOES_AVALIACAO, interpretarNota } from './avaliacao.js';

describe('interpretarNota', () => {
  it('traduz cada opcao para a nota correspondente, 0 incluso', () => {
    assert.equal(interpretarNota('0️⃣'), 0);
    assert.equal(interpretarNota('3️⃣'), 3);
    assert.equal(interpretarNota('5️⃣'), 5);
  });

  it('devolve undefined para opcao fora da lista', () => {
    assert.equal(interpretarNota('6️⃣'), undefined);
    assert.equal(interpretarNota(''), undefined);
  });

  it('tem 6 opcoes, 0 a 5', () => {
    assert.equal(OPCOES_AVALIACAO.length, 6);
  });
});
