import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizarTelefone, telefonesEquivalentes } from './telefone.js';

describe('normalizarTelefone', () => {
  it('extrai os ultimos 8 digitos, ignorando DDI e formatacao', () => {
    assert.equal(normalizarTelefone('+5534999999999'), '99999999');
  });

  it('casa com ou sem o 9º digito do celular', () => {
    assert.equal(normalizarTelefone('553499999999'), '99999999');
  });

  it('ignora o sufixo de JID do WhatsApp', () => {
    assert.equal(normalizarTelefone('553499999999@s.whatsapp.net'), '99999999');
  });

  it('string curta demais vira null, nunca compara vazio', () => {
    assert.equal(normalizarTelefone('9999'), null);
    assert.equal(normalizarTelefone(''), null);
    assert.equal(normalizarTelefone(null), null);
    assert.equal(normalizarTelefone(undefined), null);
  });
});

describe('telefonesEquivalentes', () => {
  it('true para numeros que so diferem em DDI/9/formatacao', () => {
    assert.equal(
      telefonesEquivalentes('+5534999999999', '553499999999@s.whatsapp.net'),
      true,
    );
  });

  it('false para numeros realmente diferentes', () => {
    assert.equal(
      telefonesEquivalentes('+5534999999999', '553488888888@s.whatsapp.net'),
      false,
    );
  });

  it('false quando um dos dois nao normaliza', () => {
    assert.equal(telefonesEquivalentes('123', '553499999999@s.whatsapp.net'), false);
    assert.equal(telefonesEquivalentes(null, '553499999999@s.whatsapp.net'), false);
  });
});
