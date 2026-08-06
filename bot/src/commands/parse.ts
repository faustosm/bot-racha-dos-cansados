import type { Posicao } from '../domain/tipos.js';

// Funcao pura: texto do WhatsApp -> intencao. Sem banco, sem HTTP.
//
// O grupo e de gente comum, nao de operadores de CLI: ninguem vai lembrar de
// barra-comando. Por isso o parser aceita as variacoes que as pessoas ja usam
// ("vou", "to dentro", "fora", "nao vou") em vez de exigir sintaxe.

export type Intencao =
  | { tipo: 'confirmar'; posicao: Posicao }
  | { tipo: 'desistir' }
  | { tipo: 'lista' }
  | { tipo: 'convidados'; nomes: string[] }
  /** Quer levar alguem mas nao disse quem: o bot pergunta os nomes. */
  | { tipo: 'quero_convidar' }
  | { tipo: 'meus_convidados' }
  /** `indice` ausente = "tirar" sem numero: o bot mostra a lista e pergunta. */
  | { tipo: 'tirar'; indice?: number }
  | { tipo: 'numeros'; numeros: number[] }
  | { tipo: 'todos' }
  | { tipo: 'posicao'; posicao: Posicao }
  | { tipo: 'afirmativa' }
  | { tipo: 'cancelar' }
  | { tipo: 'nao_perturbe' }
  | { tipo: 'pode_perturbar' }
  | { tipo: 'negativa' }
  | { tipo: 'ajuda' };

/** minusculas, sem acento, sem pontuacao das pontas, espacos colapsados. */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    // U+0300..U+036F: marcas de acento separadas pelo NFD.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[!.?]+$/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

const CONFIRMAR = new Set([
  'vou',
  'eu',
  'eu vou',
  'vou sim',
  'bora',
  'confirmado',
  'confirmo',
  'to dentro',
  'tou dentro',
  'estou dentro',
  'dentro',
  'presente',
]);

// ATENCAO: "cancelar" NAO entra aqui. No meio de um dialogo ("Joao joga de
// linha ou gol?"), quem digita "cancelar" quer abandonar a PERGUNTA - se isso
// virasse desistencia, a pessoa sairia do racha sem entender por que.
const DESISTIR = new Set([
  'fora',
  'to fora',
  'tou fora',
  'estou fora',
  'nao vou',
  'nao vou mais',
  'ja nao vou',
  'ja nao vou mais',
  'nao vou mais nao',
  'nao posso mais',
  'nao vou poder',
  'nao vou poder ir',
  'nao',
  'desisto',
  'desisti',
  'sai',
  'me tira',
  'me tire da lista',
  'sair da lista',
]);

const CANCELAR = new Set(['cancelar', 'cancela', 'esquece', 'deixa', 'voltar']);

// Valvula de escape: o bot passou a iniciar conversa no privado, e quem nao
// quer isso precisa de um jeito obvio de desligar. Sem saida, a pessoa bloqueia
// ou denuncia - e e isso que derruba o numero do bot.
const NAO_PERTURBE = new Set([
  'nao me chame',
  'nao me chame mais',
  'nao me chama',
  'nao me chama mais',
  'para de me chamar',
  'pare de me chamar',
  'nao quero mensagem',
  'nao quero mensagens',
  'nao me manda mensagem',
  'me deixa em paz',
  'silencio',
  'nao perturbe',
]);

const PODE_PERTURBAR = new Set([
  'pode me chamar',
  'pode chamar',
  'pode me mandar',
  'quero receber',
  'volta a me chamar',
  'pode perturbar',
]);

// Palavras de controle dentro de um dialogo. Sem elas, quem responde "Sim" a
// "vai levar convidado?" acaba com um convidado chamado Sim na lista.
// Nada que comece com "vou" entra aqui: "vou levar" tem que continuar sendo
// confirmacao de presenca no grupo, nao um "sim" solto.
const AFIRMATIVAS = new Set([
  'sim',
  's',
  'tenho',
  'tenho sim',
  'claro',
  'positivo',
  'yes',
  'ok',
  'blz',
  'beleza',
]);

const NEGATIVAS_DIALOGO = new Set([
  'nao',
  'n',
  'nenhum',
  'ninguem',
  'sozinho',
  'so eu',
  'somente eu',
  'apenas eu',
  'nao vou levar',
  'sem convidado',
  'sem convidados',
  'negativo',
  'no',
]);

const LISTA = new Set(['lista', 'quem vai', 'lista?', 'como esta a lista']);
// Sem "?" na lista: um "?" solto no grupo e conversa normal, nao pedido de
// ajuda. E no privado nao faz falta - qualquer coisa que o bot nao entende ja
// devolve a ajuda de qualquer jeito.
const AJUDA = new Set(['ajuda', 'help', 'comandos']);
const MEUS = new Set([
  'meus convidados',
  'convidados',
  'meus',
  'quem eu levei',
]);

function ehGol(t: string): boolean {
  return /\bgol(eiro)?\b/.test(t);
}

/**
 * Palavras que aparecem numa frase de convite mas nao sao nome de ninguem.
 * "vou levar um convidado" -> sobra nada -> o bot precisa perguntar quem.
 */
const GENERICAS = new Set([
  'um', 'uma', 'uns', 'umas', 'o', 'a', 'os', 'as',
  'meu', 'minha', 'meus', 'minhas', 'mais', 'outro', 'outra',
  'ao', 'no', 'na', 'para', 'pro', 'pra', 'do', 'da', 'de', 'em', 'com',
  'racha', 'jogo', 'lista', 'time', 'sabado', 'hoje',
  'convidado', 'convidados', 'convidada', 'convidadas',
  'pessoa', 'pessoas', 'amigo', 'amiga', 'amigos', 'amigas',
  'alguem', 'acompanhante', 'acompanhantes', 'colega', 'parceiro',
  'gente', 'pessoal', 'cara', 'menino', 'moleque',
]);

/** O que sobrou depois do verbo e so palavra generica, sem nome proprio? */
function soGenerico(cauda: string): boolean {
  const palavras = normalizar(cauda).split(' ').filter(Boolean);
  return palavras.length === 0 || palavras.every((p) => GENERICAS.has(p));
}

/** Tira "meu amigo", "o", "a" da frente: "meu amigo Pedro" -> "Pedro". */
function limparNome(bruto: string): string {
  const palavras = bruto.trim().split(/\s+/);
  let i = 0;
  while (i < palavras.length - 0 && palavras[i] !== undefined) {
    const p = normalizar(palavras[i] ?? '');
    if (!GENERICAS.has(p)) break;
    i += 1;
  }
  return palavras.slice(i).join(' ').trim();
}

/** Separa "Joao, Pedro e Marcelo" em nomes. */
export function separarNomes(bruto: string): string[] {
  return bruto
    .split(/\s*(?:,|;|\be\b|\+)\s*/i)
    .map((n) => limparNome(n))
    .filter((n) => n.length > 0 && n.length <= 60);
}

// Frase de convite em linguagem natural. Ninguem no grupo vai lembrar de
// "+nome" - as pessoas escrevem "vou levar um convidado" ou "quero adicionar
// uma pessoa no racha". O verbo e o que identifica a intencao; o nome, se vier,
// sai na captura.
const RE_CONVIDAR =
  /^(?:eu\s+)?(?:(?:vou|quero|posso|preciso|pretendo|gostaria\s+de|to\s+querendo|tou\s+querendo)\s+)?(?:levar|levo|trazer|trago|adicionar|adiciono|incluir|incluo|colocar|coloco|convidar|convido|chamar|chamo)\s*(.*)$/i;

const RE_CONVIDADO_PREFIXO = /^convidad[oa]s?\s*(.*)$/i;

// Remocao em linguagem natural: "quero remover um convidado", "tirar
// convidado", "tirar 2". "cancelar" NAO entra na lista de verbos - ali ele
// significa abandonar a pergunta em andamento, nao tirar ninguem.
const RE_TIRAR =
  /^(?:eu\s+)?(?:(?:vou|quero|queria|posso|preciso|pretendo|gostaria\s+de)\s+)?(?:tirar|tira|remover|remove|retirar|retira|excluir|exclui)\s*(.*)$/i;

export function parse(textoOriginal: string): Intencao | undefined {
  const original = textoOriginal.trim();
  const t = normalizar(original);
  if (!t) return undefined;

  if (AJUDA.has(t)) return { tipo: 'ajuda' };

  // Opt-out ANTES de desistir: "nao me chame" nao pode virar "sai da lista".
  if (NAO_PERTURBE.has(t)) return { tipo: 'nao_perturbe' };
  if (PODE_PERTURBAR.has(t)) return { tipo: 'pode_perturbar' };

  // Desistir vem ANTES de confirmar: "nao vou" contem "vou".
  if (DESISTIR.has(t)) {
    // "nao" sozinho e ambiguo: no meio de um dialogo e uma negativa, nao uma
    // desistencia. Quem chama resolve pelo contexto.
    return t === 'nao' ? { tipo: 'negativa' } : { tipo: 'desistir' };
  }

  if (CANCELAR.has(t)) return { tipo: 'cancelar' };
  if (NEGATIVAS_DIALOGO.has(t)) return { tipo: 'negativa' };
  if (AFIRMATIVAS.has(t)) return { tipo: 'afirmativa' };

  if (CONFIRMAR.has(t)) return { tipo: 'confirmar', posicao: 'linha' };

  // Convite ANTES de confirmar presenca: "vou levar o Pedro" comeca com "vou",
  // e a regra de confirmacao casa por prefixo. Sem esta ordem, quem quer trazer
  // convidado so conseguiria confirmar a si mesmo.
  const convite =
    /^\+\s*(.+)$/.exec(original) ??
    RE_CONVIDAR.exec(original) ??
    RE_CONVIDADO_PREFIXO.exec(original);
  if (convite) {
    const cauda = convite[1] ?? '';
    // "vou levar um convidado" nao diz QUEM: o bot pergunta em seguida.
    if (soGenerico(cauda)) return { tipo: 'quero_convidar' };
    const nomes = separarNomes(cauda);
    if (nomes.length) return { tipo: 'convidados', nomes };
    return { tipo: 'quero_convidar' };
  }

  // "vou de gol", "vou no gol", "eu vou de goleiro"
  const confirmarComPosicao = /^(vou|eu vou|bora|confirmo)\b/.test(t);
  if (confirmarComPosicao) {
    return { tipo: 'confirmar', posicao: ehGol(t) ? 'gol' : 'linha' };
  }

  if (LISTA.has(t)) return { tipo: 'lista' };
  if (MEUS.has(t)) return { tipo: 'meus_convidados' };

  // "tirar", "tirar convidado", "Quero remover um convidado", "tirar 2".
  // Mesmo tratamento do convite: a pessoa escreve uma frase, nao um comando.
  const remocao = RE_TIRAR.exec(original);
  if (remocao) {
    const cauda = normalizar(remocao[1] ?? '');
    const numero = /^(\d{1,2})$/.exec(cauda);
    if (numero) return { tipo: 'tirar', indice: Number(numero[1]) };
    // Com nome ("tirar o Joao") tambem cai aqui sem indice: o bot mostra a
    // lista numerada e pergunta. Dois convidados podem se chamar Joao, entao
    // remover por nome nao tem resposta unica.
    return { tipo: 'tirar' };
  }

  const menosNumero = /^-\s*(\d{1,2})$/.exec(t);
  if (menosNumero) return { tipo: 'tirar', indice: Number(menosNumero[1]) };

  if (t === 'todos' || t === 'todas' || t === 'tudo') return { tipo: 'todos' };

  // "1", "1 e 2", "1,2", "1 2" - escolha numa lista que o bot acabou de mostrar.
  if (/^\d{1,2}(?:\s*(?:,|;|e|\+|\s)\s*\d{1,2})*$/.test(t)) {
    const numeros = [...t.matchAll(/\d{1,2}/g)]
      .map((m) => Number(m[0]))
      .filter((n) => n > 0);
    if (numeros.length) return { tipo: 'numeros', numeros };
  }

  // Resposta a "linha ou gol?" dentro do dialogo.
  //
  // Sem atalho numerico ("1" = linha): numero solto agora significa escolha
  // numa lista ("qual convidado tirar?"), e o mesmo texto nao pode ter dois
  // sentidos. O bot pergunta com as palavras, entao a palavra basta.
  if (t === 'linha' || t === 'lin') return { tipo: 'posicao', posicao: 'linha' };
  if (t === 'gol' || t === 'goleiro') {
    return { tipo: 'posicao', posicao: 'gol' };
  }

  return undefined;
}
