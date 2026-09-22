import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  alertasDeVagas,
  cabeMais,
  contarVagas,
  formatarLista,
  motivoRecusaConvidado,
  separarFila,
  textoDePromocao,
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

  it('anuncia lista completa aos 18 de linha, e que dali pra frente e reserva', () => {
    assert.deepEqual(alertasDeVagas(vagas(18), 2), [
      '🔒 LISTA COMPLETA! 18/18 na linha.',
      'Quem marcar a partir de agora entra na reserva.',
    ]);
  });

  it('com fila, diz quantos estao esperando em vez de convidar pra reserva', () => {
    assert.deepEqual(alertasDeVagas(vagas(21), 2), [
      '🔒 LISTA COMPLETA! 18/18 na linha, 3 na reserva.',
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

// Fila de espera (21/09/2026): fixo nunca e recusado - passando das vagas ele
// vira reserva. Desde 22/09/2026 o convidado entra na mesma fila, pela ordem
// de chegada, e nao ha mais recusa por falta de vaga.
describe('fila de reserva', () => {
  const itens = (quantos: number) =>
    Array.from({ length: quantos }, (_, i) => fixoSimples(i + 1));

  it('conta os excedentes como reserva, sem estourar as vagas', () => {
    const v = contarVagas(itens(21), 18);
    assert.equal(v.ocupadas, 18);
    assert.equal(v.reservas, 3);
    assert.equal(v.livres, 0);
  });

  it('com fila, quem entra vai pra reserva em vez de ser convocado', () => {
    assert.equal(cabeMais(contarVagas(itens(19), 18)), false);
    assert.equal(cabeMais(contarVagas(itens(17), 18)), true);
  });

  it('separa convocados e reserva pela ordem de confirmacao', () => {
    const { convocados, reserva } = separarFila(itens(20), 18);
    assert.equal(convocados.length, 18);
    assert.deepEqual(
      reserva.map((i) => i.nome),
      ['J19', 'J20'],
    );
  });

  it('mostra a reserva no mesmo texto, com a numeracao continuando', () => {
    const texto = formatarLista(partida, itens(20));
    assert.match(texto, /· 18\/18 \(\+2 na reserva\)/);
    assert.match(texto, /🪑 Reserva \(entra na ordem, se alguém sair\):/);
    assert.match(texto, /19\. J19 — fixo/);
    assert.match(texto, /18\/18 de linha e 2 na reserva\./);
  });

  it('sem fila, nao inventa secao de reserva', () => {
    const texto = formatarLista(partida, itens(12));
    assert.doesNotMatch(texto, /reserva/i);
  });
});

// 22/09/2026: convidado deixou de ser recusado por falta de vaga. A janela de
// quarta 12:00 a quinta 12:00 ja da aos fixos a lista so pra eles - quem marca
// depois disso nao passa na frente de um convidado que chegou antes. O que
// sobrou de limite e a cota por padrinho, sem a qual um fixo sozinho empurra a
// fila inteira pra tras.
describe('motivoRecusaConvidado', () => {
  it('nao recusa quem ainda nao usou a cota', () => {
    assert.equal(motivoRecusaConvidado(0, 1), undefined);
  });

  it('recusa o segundo convidado quando a cota e 1', () => {
    const m = motivoRecusaConvidado(1, 1) ?? '';
    assert.match(m, /1 convidado/);
    assert.match(m, /já tem o seu/i);
    // Recusa de linha e sobre linha: nao pode confundir com o teto de gol,
    // que e separado (motivoRecusaGoleiro).
    assert.doesNotMatch(m, /goleiro/i);
  });

  it('com cota maior, diz quantos a pessoa ja tem', () => {
    const m = motivoRecusaConvidado(2, 2) ?? '';
    assert.match(m, /2 convidados/);
    assert.match(m, /já tem 2/);
  });

  it('nao fala de vaga nem de lista cheia - nao e mais esse o criterio', () => {
    const m = motivoRecusaConvidado(1, 1) ?? '';
    assert.doesNotMatch(m, /vaga|completa|reserva/i);
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

// 22/09/2026: o aviso de promocao passou a sair por PESSOA, nao por promocao.
// Antes, um fixo que subia junto com o convidado dele recebia duas mensagens
// seguidas dizendo quase a mesma coisa. E o convidado, que nao tem WhatsApp
// cadastrado, so tinha o anuncio do grupo - quem precisa saber e o padrinho,
// que vai leva-lo no sabado.
describe('aviso de quem subiu da reserva', () => {
  const quando = 'sábado 26/09';
  const texto = (quem: { eu: boolean; convidados: string[] }) =>
    textoDePromocao(quem, quando).join('\n');

  it('so o fixo: fala com ele e ensina a sair', () => {
    const t = texto({ eu: true, convidados: [] });
    assert.match(t, /você entrou/i);
    assert.match(t, /"não vou mais"/);
    assert.doesNotMatch(t, /convidado/i);
  });

  it('so o convidado: fala com o padrinho, nao com o convidado', () => {
    const t = texto({ eu: false, convidados: ['Pedrinho'] });
    assert.match(t, /Pedrinho, seu convidado, entrou/);
    // Quem le e o padrinho: "voce entrou" aqui seria mentira.
    assert.doesNotMatch(t, /você entrou/i);
    assert.match(t, /"Pedrinho não vai mais"/);
  });

  it('os dois na mesma saida: UMA mensagem, nao duas', () => {
    const t = texto({ eu: true, convidados: ['Pedrinho'] });
    assert.match(t, /Você e Pedrinho/);
    assert.match(t, /agora estão escalados/);
    // O texto precisa ensinar a tirar qualquer um dos dois.
    assert.match(t, /"não vou mais"/);
    assert.match(t, /"Pedrinho não vai mais"/);
  });

  it('mais de um convidado: cita todos com "e" antes do ultimo', () => {
    const t = texto({ eu: false, convidados: ['Pedrinho', 'Kaique'] });
    assert.match(t, /Pedrinho e Kaique entraram/);
    assert.match(t, /estão escalados/);
  });

  it('sempre diz de que jogo esta falando', () => {
    for (const quem of [
      { eu: true, convidados: [] },
      { eu: false, convidados: ['Pedrinho'] },
      { eu: true, convidados: ['Pedrinho'] },
    ]) {
      assert.match(texto(quem), /sábado 26\/09/);
    }
  });
});
