import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizar, parse, separarNomes } from './parse.js';

describe('normalizar', () => {
  it('tira acento, caixa e pontuacao final', () => {
    assert.equal(normalizar('NÃO VOU!'), 'nao vou');
    assert.equal(normalizar('  Vou   sim  '), 'vou sim');
  });
});

describe('parse - confirmar', () => {
  // "vou no racha" e o texto que o link wa.me dos anuncios preenche: se parar
  // de ser reconhecido, o caminho de entrada do grupo inteiro quebra.
  for (const t of [
    'vou',
    'Vou',
    'vou no racha',
    'Vou no racha',
    'eu',
    'bora',
    'to dentro',
    'presente',
  ]) {
    it(`"${t}" confirma na linha`, () => {
      assert.deepEqual(parse(t), { tipo: 'confirmar', posicao: 'linha' });
    });
  }

  for (const t of ['vou de gol', 'vou no gol', 'eu vou de goleiro']) {
    it(`"${t}" confirma no gol`, () => {
      assert.deepEqual(parse(t), { tipo: 'confirmar', posicao: 'gol' });
    });
  }
});

describe('parse - desistir', () => {
  // A armadilha: "nao vou" contem "vou". Se a ordem de checagem inverter,
  // quem esta saindo entra na lista.
  for (const t of [
    'fora',
    'to fora',
    'nao vou',
    'NÃO VOU',
    'desisto',
    'Não vou mais',
    'nao vou mais',
    'já não vou mais',
    'não posso mais',
    'não vou poder ir',
  ]) {
    it(`"${t}" desiste`, () => {
      assert.deepEqual(parse(t), { tipo: 'desistir' });
    });
  }

  it('"nao" sozinho e negativa, nao desistencia', () => {
    assert.deepEqual(parse('nao'), { tipo: 'negativa' });
  });
});

describe('parse - palavras de controle do dialogo', () => {
  // Regressao real: "Sim" respondido a "vai levar convidado?" virava um
  // convidado chamado Sim.
  for (const t of ['Sim', 'sim', 'claro', 'tenho sim', 'ok']) {
    it(`"${t}" e afirmativa, nao nome de convidado`, () => {
      assert.deepEqual(parse(t), { tipo: 'afirmativa' });
    });
  }

  for (const t of ['nenhum', 'ninguém', 'só eu', 'sem convidados']) {
    it(`"${t}" e negativa`, () => {
      assert.deepEqual(parse(t), { tipo: 'negativa' });
    });
  }

  it('"vou levar" e intencao de convidar, nao confirmacao', () => {
    // Mudou de proposito: antes "vou levar" caia na regra de confirmacao por
    // comecar com "vou". Quem escreve isso quer trazer alguem, e o bot
    // pergunta quem. Confirmar presenca continua sendo "vou".
    assert.deepEqual(parse('vou levar'), { tipo: 'quero_convidar' });
    assert.deepEqual(parse('vou'), { tipo: 'confirmar', posicao: 'linha' });
  });
});

describe('parse - opt-out de mensagem do bot', () => {
  for (const t of [
    'não me chame',
    'nao me chame mais',
    'para de me chamar',
    'não quero mensagem',
    'me deixa em paz',
  ]) {
    it(`"${t}" desliga as mensagens do bot`, () => {
      assert.deepEqual(parse(t), { tipo: 'nao_perturbe' });
    });
  }

  it('"não me chame" NAO pode virar desistencia', () => {
    // Comeca com "nao", e "nao vou"/"nao" saem da lista. Se a ordem de
    // checagem inverter, quem so queria silencio sai do racha.
    assert.notDeepEqual(parse('nao me chame'), { tipo: 'desistir' });
  });

  it('"pode me chamar" religa', () => {
    assert.deepEqual(parse('pode me chamar'), { tipo: 'pode_perturbar' });
  });
});

describe('parse - cancelar NAO e desistir', () => {
  // Bug evitado: com "cancelar" dentro do grupo de desistencia, quem estava no
  // meio da pergunta "Joao joga de linha ou gol?" e digitava "cancelar" saia do
  // racha inteiro sem entender por que.
  for (const t of ['cancelar', 'cancela', 'esquece', 'deixa']) {
    it(`"${t}" cancela o dialogo`, () => {
      assert.deepEqual(parse(t), { tipo: 'cancelar' });
    });
  }

  for (const t of ['fora', 'desisto', 'me tira']) {
    it(`"${t}" continua saindo da lista`, () => {
      assert.deepEqual(parse(t), { tipo: 'desistir' });
    });
  }
});

describe('parse - convidados', () => {
  it('aceita + com varios nomes', () => {
    assert.deepEqual(parse('+João, Pedro e Marcelo'), {
      tipo: 'convidados',
      nomes: ['João', 'Pedro', 'Marcelo'],
    });
  });

  it('preserva acento e caixa do nome', () => {
    assert.deepEqual(parse('convidado José'), {
      tipo: 'convidados',
      nomes: ['José'],
    });
  });
});

describe('parse - convite em linguagem natural', () => {
  // Ninguem no grupo vai lembrar de "+nome". As pessoas escrevem frases.
  for (const t of [
    'Vou levar um convidado',
    'vou levar convidado',
    'Quero adicionar uma pessoa ao racha',
    'posso levar um amigo',
    'quero convidar alguem',
    'vou trazer mais um',
    'gostaria de levar uma pessoa',
  ]) {
    it(`"${t}" abre a pergunta de quem`, () => {
      assert.deepEqual(parse(t), { tipo: 'quero_convidar' });
    });
  }

  it('com o nome junto, ja registra sem perguntar', () => {
    assert.deepEqual(parse('vou levar o João'), {
      tipo: 'convidados',
      nomes: ['João'],
    });
    assert.deepEqual(parse('quero adicionar o Pedro e a Ana'), {
      tipo: 'convidados',
      nomes: ['Pedro', 'Ana'],
    });
  });

  it('tira "meu amigo" da frente do nome', () => {
    assert.deepEqual(parse('vou levar meu amigo Marcelo'), {
      tipo: 'convidados',
      nomes: ['Marcelo'],
    });
  });

  it('nao rouba a confirmacao de presenca simples', () => {
    assert.deepEqual(parse('vou'), { tipo: 'confirmar', posicao: 'linha' });
    assert.deepEqual(parse('vou de gol'), {
      tipo: 'confirmar',
      posicao: 'gol',
    });
  });
});

describe('parse - tirar', () => {
  it('aceita "tirar 2" e "-2"', () => {
    assert.deepEqual(parse('tirar 2'), { tipo: 'tirar', indice: 2 });
    assert.deepEqual(parse('-2'), { tipo: 'tirar', indice: 2 });
  });

  for (const t of [
    'tirar',
    'tirar convidado',
    'Quero remover um convidado',
    'Quero tirar um convidado',
    'quero tira um convidado',
    'preciso remover uma pessoa',
    'retirar convidado',
    'excluir um convidado',
  ]) {
    it(`"${t}" pede a lista numerada, sem indice`, () => {
      assert.deepEqual(parse(t), { tipo: 'tirar' });
    });
  }

  it('com nome tambem mostra a lista, nao remove direto', () => {
    // Dois convidados podem se chamar Joao: remover por nome nao tem
    // resposta unica, entao o bot pergunta pelo numero.
    assert.deepEqual(parse('tirar o João'), { tipo: 'tirar' });
  });

  it('"cancelar" nao e remocao', () => {
    assert.deepEqual(parse('cancelar'), { tipo: 'cancelar' });
  });
});

describe('parse - escolha numa lista', () => {
  it('aceita um numero, varios, e "todos"', () => {
    assert.deepEqual(parse('1'), { tipo: 'numeros', numeros: [1] });
    assert.deepEqual(parse('1, 2'), { tipo: 'numeros', numeros: [1, 2] });
    assert.deepEqual(parse('1 e 3'), { tipo: 'numeros', numeros: [1, 3] });
    assert.deepEqual(parse('todos'), { tipo: 'todos' });
  });
});

describe('parse - posicao no dialogo', () => {
  it('"linha" e "gol" respondem a pergunta', () => {
    assert.deepEqual(parse('linha'), { tipo: 'posicao', posicao: 'linha' });
    assert.deepEqual(parse('gol'), { tipo: 'posicao', posicao: 'gol' });
  });

  it('numero NAO e atalho de posicao', () => {
    // "1" agora significa escolha numa lista numerada. Se voltasse a ser
    // "linha", escolher convidado para remover viraria ambiguidade.
    assert.deepEqual(parse('1'), { tipo: 'numeros', numeros: [1] });
  });
});

describe('parse - "lista" no grupo casa exato', () => {
  // "lista" e o unico comando aceito no grupo. Como o grupo conversa livremente,
  // ele NAO pode casar por prefixo nem por conteudo.
  it('aciona com a palavra sozinha', () => {
    assert.deepEqual(parse('lista'), { tipo: 'lista' });
    assert.deepEqual(parse('Lista'), { tipo: 'lista' });
  });

  for (const t of [
    'manda a lista ai',
    'cade a lista',
    'listagem',
    'a lista ta grande',
  ]) {
    it(`nao aciona com "${t}"`, () => {
      assert.notDeepEqual(parse(t), { tipo: 'lista' });
    });
  }
});

describe('parse - "ajuda" no grupo', () => {
  it('aciona com ajuda, help e comandos', () => {
    assert.deepEqual(parse('ajuda'), { tipo: 'ajuda' });
    assert.deepEqual(parse('help'), { tipo: 'ajuda' });
    assert.deepEqual(parse('comandos'), { tipo: 'ajuda' });
  });

  it('"?" sozinho NAO e pedido de ajuda', () => {
    // No grupo um "?" solto e conversa normal. No privado nao faz falta: o
    // fallback ja devolve a ajuda para qualquer coisa nao entendida.
    assert.equal(parse('?'), undefined);
  });

  it('nao aciona no meio de uma frase', () => {
    assert.notDeepEqual(parse('preciso de ajuda com a chuteira'), {
      tipo: 'ajuda',
    });
  });
});

describe('parse - silencio', () => {
  // O grupo conversa sobre outras coisas: o bot nao pode responder a tudo.
  for (const t of ['bom dia', 'alguem viu meu chuteira?', '']) {
    it(`ignora "${t}"`, () => {
      assert.equal(parse(t), undefined);
    });
  }
});

describe('separarNomes', () => {
  it('separa por virgula, ponto-e-virgula e "e"', () => {
    assert.deepEqual(separarNomes('Ana, Bia; Carlos e Duda'), [
      'Ana',
      'Bia',
      'Carlos',
      'Duda',
    ]);
  });
});
