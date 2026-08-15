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
      assert.deepEqual(parse(t), { tipo: 'confirmar' });
    });
  }

  it('"vou de gol" tambem so confirma presenca', () => {
    // Fixo nao se auto-marca goleiro (decisao deliberada, nao ha pergunta de
    // posicao aqui) - a frase continua valendo como confirmacao de linha para
    // nao quebrar quem digita.
    assert.deepEqual(parse('vou de gol'), { tipo: 'confirmar' });
  });
});

describe('parse - nao perturbe', () => {
  it('"nao perturbe" desliga as mensagens que o bot inicia', () => {
    assert.deepEqual(parse('não perturbe'), { tipo: 'nao_perturbe' });
    assert.deepEqual(parse('para de me chamar'), { tipo: 'nao_perturbe' });
  });

  it('"pode chamar" religa', () => {
    assert.deepEqual(parse('pode chamar'), { tipo: 'pode_chamar' });
    assert.deepEqual(parse('volta a chamar'), { tipo: 'pode_chamar' });
  });
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
    assert.deepEqual(parse('vou'), { tipo: 'confirmar' });
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
    assert.deepEqual(parse('vou'), { tipo: 'confirmar' });
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

describe('parse - tirar convidado pelo nome', () => {
  for (const [texto, nome] of [
    ['João não vai mais', 'João'],
    ['tirar o João', 'João'],
    ['remover João', 'João'],
    ['quero tirar o João Silva', 'João Silva'],
    ['o Pedro não vai', 'Pedro'],
  ] as const) {
    it(`"${texto}" tira ${nome}`, () => {
      assert.deepEqual(parse(texto), { tipo: 'tirar_convidado', nome });
    });
  }

  it('NAO confunde com a propria desistencia', () => {
    // "nao vou mais" e a pessoa saindo; "Joao nao vai mais" e o convidado.
    // Se a ordem de checagem inverter, quem quer sair tira um convidado.
    assert.deepEqual(parse('não vou mais'), { tipo: 'desistir' });
    assert.deepEqual(parse('fora'), { tipo: 'desistir' });
  });
});
