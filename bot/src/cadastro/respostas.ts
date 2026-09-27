/**
 * Funcoes puras do cadastro de quem entra no grupo: interpretar as respostas
 * do questionario e montar o jogador do app. Sem banco, sem rede - testavel
 * sozinho (ver respostas.test.ts). A parte com I/O fica em fluxo.ts.
 */
import { normalizar } from '../commands/parse.js';
import { normalizarTelefone } from '../app-sync/telefone.js';
import type { AppPlayer } from '../app-sync/client.js';

export type Posicao = 'linha' | 'goleiro';

/** Opcoes da enquete de posicao, na ordem mostrada. */
export const OPCOES_POSICAO = ['⚽ Linha', '🧤 Goleiro'] as const;

const MIN_NOME = 2;
const MAX_NOME = 40;

/** Nome digitado, limpo. `undefined` se nao parece um nome. */
export function interpretarNome(texto: string): string | undefined {
  const nome = texto.trim().replace(/\s+/g, ' ');
  if (nome.length < MIN_NOME || nome.length > MAX_NOME) return undefined;
  // Pelo menos uma letra: "123" ou "👍" nao servem de nome na lista.
  if (!/\p{L}/u.test(nome)) return undefined;
  return nome;
}

const PULAR = new Set([
  'pular', 'pula', 'pulo', 'nao', 'n', 'nenhum', 'nao tenho', 'sem apelido',
  'nao tenho apelido', 'nada', '-', 'x',
]);

/** Apelido digitado, ou `null` se a pessoa pulou. */
export function interpretarApelido(texto: string): string | null {
  if (PULAR.has(normalizar(texto))) return null;
  return interpretarNome(texto) ?? null;
}

const LINHA = new Set(['1', 'linha', 'jogador de linha', 'na linha', 'de linha', 'jogo na linha']);
const GOLEIRO = new Set(['2', 'gol', 'goleiro', 'goleira', 'no gol', 'jogo no gol', 'sou goleiro']);

/** Posicao por texto (fallback da enquete). */
export function interpretarPosicao(texto: string): Posicao | undefined {
  const t = normalizar(texto).replace(/^[^\p{L}\d]+/u, '').trim();
  if (LINHA.has(t)) return 'linha';
  if (GOLEIRO.has(t)) return 'goleiro';
  return undefined;
}

/** Posicao pela opcao escolhida na enquete. */
export function posicaoDaOpcao(opcao: string): Posicao | undefined {
  if (opcao === OPCOES_POSICAO[0]) return 'linha';
  if (opcao === OPCOES_POSICAO[1]) return 'goleiro';
  return undefined;
}

const NINGUEM = new Set([
  'ninguem', 'nenhum', 'ninguem me convidou', 'nao sei', 'sei nao', 'ninguem nao',
  'entrei sozinho', 'sozinho', 'pular', 'nao',
]);

/** "Quem te convidou?" respondido com "ninguem" e afins. */
export function ehNinguem(texto: string): boolean {
  return NINGUEM.has(normalizar(texto));
}

/**
 * JID do WhatsApp -> telefone legivel pro app: "(34) 99999-9999".
 *
 * O JID de muitos celulares brasileiros vem sem o 9 da frente (numero antigo,
 * 8 digitos). No app o numero e lido por gente, entao devolve o 9 quando o
 * assinante e de celular (comeca com 6-9). O casamento por telefone
 * (telefone.ts) compara so os ultimos 8, entao funciona com ou sem o 9.
 */
export function telefoneParaApp(jid: string): string | undefined {
  const digitos = jid.split('@')[0] ?? '';
  if (!/^55\d{10,11}$/.test(digitos)) return undefined;
  const ddd = digitos.slice(2, 4);
  let assinante = digitos.slice(4);
  if (assinante.length === 8 && /^[6-9]/.test(assinante)) assinante = `9${assinante}`;
  return `(${ddd}) ${assinante.slice(0, -4)}-${assinante.slice(-4)}`;
}

/** Ultimos 4 digitos do telefone, pro nome provisorio "Novo (final 1234)". */
export function finalDoTelefone(jid: string): string {
  return (jid.split('@')[0] ?? '').replace(/\D/g, '').slice(-4);
}

const mesmoNome = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * O app recusa dois jogadores com o mesmo nome (isDuplicateName, sem
 * diferenciar maiusculas). Tenta o nome puro, depois com o apelido, depois
 * com o final do telefone - que sempre diferencia.
 */
export function nomeLivreNoApp(
  players: readonly AppPlayer[],
  nome: string,
  apelido: string | null,
  final: string,
): string {
  const ocupado = (n: string) => players.some((p) => typeof p.name === 'string' && mesmoNome(p.name, n));
  const tentativas = [nome, ...(apelido ? [`${nome} (${apelido})`] : []), `${nome} (final ${final})`];
  for (const t of tentativas) if (!ocupado(t)) return t;
  return `${nome} (final ${final}) ${players.length}`;
}

/** Jogador do app com esse telefone (mesma regra dos ultimos 8 digitos). */
export function jogadorDoAppPorTelefone(
  players: readonly AppPlayer[],
  telefone: string | null | undefined,
): AppPlayer | undefined {
  const alvo = normalizarTelefone(telefone);
  if (!alvo) return undefined;
  return players.find((p) => normalizarTelefone(p.phone) === alvo);
}

export interface NovoJogadorApp {
  readonly id: string;
  readonly nome: string;
  readonly apelido: string | null;
  readonly telefone: string | undefined;
  /** Id (no app) de quem convidou, se achou. */
  readonly convidadoPor: string | null;
  /** config.perPlayerValue do app - o mesmo valor que o app poe ao cadastrar. */
  readonly valorPorJogador: string;
}

/**
 * Mesmo formato do "adicionar jogador" do app (App.jsx), sempre como
 * convidado: se e fixo ou goleiro contratado e decisao do comite, feita no
 * app depois. Nivel "Grupo ?" (0): ninguem avaliou a pessoa ainda, e o
 * sorteio ja trata esse nivel como desconhecido.
 */
export function montarJogadorApp(n: NovoJogadorApp): AppPlayer {
  return {
    id: n.id,
    name: n.nome,
    nickname: n.apelido,
    phone: n.telefone ?? null,
    category: 'convidado',
    invitedBy: n.convidadoPor,
    skill: 0,
    paid: false,
    amount: n.valorPorJogador,
    paymentMethod: null,
  };
}
