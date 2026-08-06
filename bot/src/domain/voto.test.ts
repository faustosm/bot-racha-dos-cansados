import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decifrarVoto, hashDaOpcao, opcoesEscolhidas } from './voto.js';

// VETOR REAL, capturado do grupo de teste em 06/08/2026.
//
// Nao e dado sintetico: e uma enquete de verdade, votada de verdade, com o
// payload que a Evolution entregou no webhook. Se a decriptacao quebrar - por
// mudanca no WhatsApp, no Baileys ou num refactor nosso - este teste falha.
//
// Os identificadores estao no formato @lid de proposito: em grupo com LID, o
// formato telefone NAO decifra. Foi a descoberta que destravou a fase.

const ENC_PAYLOAD = new Uint8Array([
  156, 196, 225, 20, 163, 16, 48, 38, 127, 4, 138, 28, 180, 241, 236, 57, 46,
  46, 214, 129, 230, 17, 125, 147, 237, 51, 157, 225, 210, 216, 41, 43, 129,
  153, 239, 157, 54, 9, 114, 14, 136, 67, 109, 228, 111, 36, 114, 13, 251, 216,
]);

const ENC_IV = new Uint8Array([
  37, 63, 197, 153, 226, 238, 89, 51, 94, 17, 6, 233,
]);

const SEGREDO = new Uint8Array([
  161, 225, 88, 167, 124, 131, 56, 42, 15, 164, 75, 227, 11, 255, 12, 90, 216,
  133, 247, 143, 198, 25, 181, 106, 76, 104, 49, 208, 157, 80, 111, 182,
]);

const CTX = {
  enqueteId: '3EB05A3FC03BC3559A5983',
  criadorJid: '10952770609328@lid',
  votanteJid: '103440025919502@lid',
  segredo: SEGREDO,
};

const OPCOES = [
  '✅ Vou',
  '🧤 Vou de gol',
  '👥 Vou e levo convidado',
  '❌ Nao vou',
  '🤔 Talvez',
];

describe('decifrarVoto - vetor real do grupo', () => {
  it('decifra o voto e identifica a opcao escolhida', () => {
    const hashes = decifrarVoto({ encPayload: ENC_PAYLOAD, encIv: ENC_IV }, CTX);
    assert.ok(hashes, 'nao decifrou');
    assert.deepEqual(opcoesEscolhidas(hashes, OPCOES), ['✅ Vou']);
  });

  it('com JID de telefone no lugar do LID, NAO decifra', () => {
    // Trava a descoberta: a documentacao da comunidade manda usar
    // @s.whatsapp.net, e e por isso que o Baileys falha em grupo com LID.
    const comTelefone = decifrarVoto(
      { encPayload: ENC_PAYLOAD, encIv: ENC_IV },
      {
        ...CTX,
        criadorJid: '553497062526@s.whatsapp.net',
        votanteJid: '553491705227@s.whatsapp.net',
      },
    );
    assert.equal(comTelefone, undefined);
  });

  it('devolve undefined em vez de explodir quando o segredo esta errado', () => {
    const r = decifrarVoto(
      { encPayload: ENC_PAYLOAD, encIv: ENC_IV },
      { ...CTX, segredo: new Uint8Array(32) },
    );
    assert.equal(r, undefined);
  });

  it('devolve undefined com payload truncado', () => {
    const r = decifrarVoto(
      { encPayload: ENC_PAYLOAD.slice(0, 8), encIv: ENC_IV },
      CTX,
    );
    assert.equal(r, undefined);
  });
});

describe('opcoesEscolhidas', () => {
  it('ignora hash que nao corresponde a nenhuma opcao', () => {
    assert.deepEqual(opcoesEscolhidas(['00'.repeat(32)], OPCOES), []);
  });

  it('casa pelo texto exato da opcao, emoji incluso', () => {
    assert.deepEqual(opcoesEscolhidas([hashDaOpcao('❌ Nao vou')], OPCOES), [
      '❌ Nao vou',
    ]);
    // Mesmo texto sem o emoji e outra opcao: o hash e do texto inteiro.
    assert.deepEqual(opcoesEscolhidas([hashDaOpcao('Nao vou')], OPCOES), []);
  });
});
