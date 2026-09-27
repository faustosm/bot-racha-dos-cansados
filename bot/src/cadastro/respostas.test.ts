import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPCOES_POSICAO,
  ehNinguem,
  interpretarApelido,
  interpretarNome,
  interpretarPosicao,
  jogadorDoAppPorTelefone,
  montarJogadorApp,
  nomeLivreNoApp,
  posicaoDaOpcao,
  telefoneParaApp,
} from './respostas.js';

describe('interpretarNome', () => {
  it('limpa espacos', () => {
    assert.equal(interpretarNome('  João   Silva '), 'João Silva');
  });
  it('recusa o que nao parece nome', () => {
    assert.equal(interpretarNome('1'), undefined);
    assert.equal(interpretarNome('👍👍'), undefined);
    assert.equal(interpretarNome('x'.repeat(41)), undefined);
  });
});

describe('interpretarApelido', () => {
  it('pular vira null', () => {
    assert.equal(interpretarApelido('Pular'), null);
    assert.equal(interpretarApelido('não tenho'), null);
  });
  it('apelido normal passa', () => {
    assert.equal(interpretarApelido('Joãozinho'), 'Joãozinho');
  });
});

describe('interpretarPosicao', () => {
  it('aceita texto e numero', () => {
    assert.equal(interpretarPosicao('Linha'), 'linha');
    assert.equal(interpretarPosicao('1'), 'linha');
    assert.equal(interpretarPosicao('gol'), 'goleiro');
    assert.equal(interpretarPosicao('Goleiro!'), 'goleiro');
    assert.equal(interpretarPosicao('🧤 Goleiro'), 'goleiro');
  });
  it('ignora o resto', () => {
    assert.equal(interpretarPosicao('meio campo'), undefined);
  });
  it('mapeia as opcoes da enquete', () => {
    assert.equal(posicaoDaOpcao(OPCOES_POSICAO[0]), 'linha');
    assert.equal(posicaoDaOpcao(OPCOES_POSICAO[1]), 'goleiro');
  });
});

describe('ehNinguem', () => {
  it('reconhece variacoes', () => {
    assert.equal(ehNinguem('Ninguém'), true);
    assert.equal(ehNinguem('nenhum'), true);
    assert.equal(ehNinguem('Welker'), false);
  });
});

describe('telefoneParaApp', () => {
  it('poe o 9 do celular quando o JID vem sem', () => {
    assert.equal(telefoneParaApp('553488887777@s.whatsapp.net'), '(34) 98888-7777');
  });
  it('mantem quando ja tem o 9', () => {
    assert.equal(telefoneParaApp('5534988887777@s.whatsapp.net'), '(34) 98888-7777');
  });
  it('fixo nao ganha 9', () => {
    assert.equal(telefoneParaApp('553432221111@s.whatsapp.net'), '(34) 3222-1111');
  });
  it('recusa o que nao e telefone brasileiro', () => {
    assert.equal(telefoneParaApp('123456@lid'), undefined);
  });
});

describe('nomeLivreNoApp', () => {
  const players = [{ id: 'a', name: 'João' }, { id: 'b', name: 'joão (Jão)' }];
  it('usa o nome puro quando livre', () => {
    assert.equal(nomeLivreNoApp(players, 'Pedro', null, '7777'), 'Pedro');
  });
  it('desempata com apelido e depois com o final do telefone', () => {
    assert.equal(nomeLivreNoApp(players, 'João', 'Jão', '7777'), 'João (final 7777)');
    assert.equal(nomeLivreNoApp(players, 'João', 'Joca', '7777'), 'João (Joca)');
  });
});

describe('jogadorDoAppPorTelefone', () => {
  it('casa pelos ultimos 8 digitos', () => {
    const players = [{ id: 'a', name: 'A', phone: '(34) 98888-7777' }];
    assert.equal(jogadorDoAppPorTelefone(players, '553488887777@s.whatsapp.net')?.id, 'a');
    assert.equal(jogadorDoAppPorTelefone(players, '553411112222@s.whatsapp.net'), undefined);
  });
});

describe('montarJogadorApp', () => {
  it('entra como convidado, nivel desconhecido, nao pago', () => {
    const p = montarJogadorApp({
      id: 'x', nome: 'João', apelido: null, telefone: '(34) 98888-7777',
      convidadoPor: 'y', valorPorJogador: '20',
    });
    assert.equal(p.category, 'convidado');
    assert.equal(p.invitedBy, 'y');
    assert.equal(p.skill, 0);
    assert.equal(p.paid, false);
    assert.equal(p.amount, '20');
  });
});
