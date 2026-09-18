import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatarLista,
  mensagemAindaTemVaga,
  mensagemEntrouNaReserva,
  mensagemListaCheia,
  mensagemSubiuDaReserva,
} from './lista.js';
import { OPCAO_RESERVA, OPCOES, interpretar } from './enquete.js';
import { hashDaOpcao } from './voto.js';
import type { ItemLista, ItemReserva } from './tipos.js';

// A reserva (18/09/2026). O que da pra testar sem banco: o texto que o grupo
// le e o contrato da enquete - que e justamente onde um erro passa batido no
// typecheck e so aparece com gente esperando vaga.

const partida = { data_jogo: '2026-09-26', vagas_total: 18 };

const fixo = (id: number): ItemLista => ({
  id,
  nome: `J${id}`,
  tipo: 'fixo',
  posicao: 'linha',
  jogadorId: id,
});

const naReserva = (id: number, nome: string, querConvidado = false): ItemReserva => ({
  id,
  jogadorId: id,
  nome,
  querConvidado,
});

const lotada = Array.from({ length: 18 }, (_, i) => fixo(i + 1));

describe('a opcao Reserva na enquete', () => {
  it('e a quarta e ultima opcao', () => {
    // O voto identifica a opcao pelo hash do texto: acrescentar no FIM e o que
    // mantem as tres antigas com o mesmo hash, e uma enquete ja publicada
    // continua sendo lida certo. Inverter a ordem aqui quebraria isso em
    // silencio - o bot so descobriria com os votos da semana chegando errados.
    assert.equal(OPCOES.length, 4);
    assert.equal(OPCOES[3], OPCAO_RESERVA);
  });

  it('nao mudou o hash das tres opcoes antigas', () => {
    // Congelados a partir das enquetes ja publicadas em producao.
    assert.equal(
      hashDaOpcao('✅ Vou'),
      hashDaOpcao(OPCOES[0] ?? ''),
    );
    assert.equal(
      hashDaOpcao('👥 Vou com convidado'),
      hashDaOpcao(OPCOES[1] ?? ''),
    );
    assert.equal(
      hashDaOpcao('❌ Não vou'),
      hashDaOpcao(OPCOES[2] ?? ''),
    );
  });

  it('vira a acao de reservar', () => {
    assert.deepEqual(interpretar(OPCAO_RESERVA), { tipo: 'reservar' });
  });
});

describe('a reserva na lista publicada', () => {
  it('aparece num bloco proprio, com numeracao propria', () => {
    const texto = formatarLista(partida, lotada, [], 'Racha', [
      naReserva(90, 'Thiago'),
      naReserva(91, 'Welker'),
    ]);
    assert.match(texto, /🕒 Reservas/);
    assert.match(texto, / 1\. Thiago/);
    assert.match(texto, / 2\. Welker/);
  });

  it('nao entra no X/18 - quem esta na reserva nao ocupa vaga', () => {
    const texto = formatarLista(partida, lotada, [], 'Racha', [
      naReserva(90, 'Thiago'),
      naReserva(91, 'Welker'),
    ]);
    assert.match(texto, /18\/18 de linha\./);
    assert.doesNotMatch(texto, /20\/18/);
  });

  it('nao aparece quando nao ha ninguem esperando', () => {
    // Bloco vazio sairia em todo digest de semana tranquila, sem dizer nada.
    const texto = formatarLista(partida, lotada, [], 'Racha', []);
    assert.doesNotMatch(texto, /Reservas/);
  });

  it('marca quem esperava com convidado', () => {
    const texto = formatarLista(partida, lotada, [], 'Racha', [
      naReserva(90, 'Marcus', true),
    ]);
    assert.match(texto, /Marcus \(\+1 convidado\)/);
  });

  it('vem depois dos goleiros, nunca no meio da lista de linha', () => {
    const texto = formatarLista(partida, lotada, [], 'Racha', [
      naReserva(90, 'Thiago'),
    ]);
    assert.ok(texto.indexOf('🧤') < texto.indexOf('🕒 Reservas'));
  });
});

describe('as mensagens da reserva', () => {
  const cheia = { ocupadas: 18, total: 18, livres: 0 };
  const comFolga = { ocupadas: 12, total: 18, livres: 6 };

  it('com a lista cheia, aponta para a opcao da enquete', () => {
    const texto = mensagemListaCheia('Thiago', cheia, OPCAO_RESERVA);
    assert.match(texto, /18\/18/);
    assert.match(texto, /🕒 Reserva/);
  });

  it('com vaga sobrando, manda de volta pro "Vou" em vez de reservar', () => {
    // Ficar de fora tendo vaga e o pior desfecho possivel - foi por isso que a
    // opcao ganhou porteiro.
    const texto = mensagemAindaTemVaga('Thiago', comFolga);
    assert.match(texto, /ainda tem vaga \(12\/18\)/);
    assert.match(texto, /✅ Vou/);
  });

  it('diz a posicao de quem entrou na reserva', () => {
    assert.match(mensagemEntrouNaReserva('Thiago', 2), /Thiago entrou na reserva \(2º\)/);
  });

  it('concorda o verbo com quantos subiram', () => {
    assert.match(mensagemSubiuDaReserva(['Thiago']), /Subiu da reserva: Thiago\./);
    assert.match(
      mensagemSubiuDaReserva(['Thiago', 'Welker']),
      /Subiram da reserva: Thiago, Welker\./,
    );
  });
});
