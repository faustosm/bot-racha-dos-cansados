/**
 * Ferramenta de LEITURA (nao toca no banco, nao manda nada pro grupo).
 *
 * Imprime no terminal os textos que o bot publica na semana, com uma lista
 * ficticia - serve para revisar redacao sem zerar dados nem ocupar o grupo
 * com ensaio (`simular-abertura.ts` faz as duas coisas, de proposito).
 *
 *   docker compose exec bot npx tsx src/dev/previa-textos.ts
 */
import { config } from '../config.js';
import { mensagemAberturaFixos } from '../scheduler.js';
import { tituloDaEnquete, OPCOES } from '../domain/enquete.js';
import { proximoSabado } from '../domain/datas.js';
import { alertasDeVagas, contarVagas, formatarLista, rotuloData } from '../domain/lista.js';
import type { ItemGoleiro, ItemLista } from '../domain/tipos.js';

const NOMES = [
  'Fausto', 'Alexson', 'Rhandlley', 'Junior Mamedio', 'Thiago Miranda',
  'Marcus Vinicius', 'Rafael Mendes', 'Welker', 'Wibio', 'Otávio',
  'Paulo', 'Gustavo', 'Thiago Juliano', 'Daniel', 'Bruno',
  'Leandro', 'Everton', 'Diego', 'Murilo', 'Caio',
];

const dataJogo = proximoSabado(new Date());
const partida = {
  data_jogo: dataJogo,
  vagas_total: config.VAGAS_TOTAL,
  vagas_goleiro: config.VAGAS_GOLEIRO,
};

function fixo(n: number): ItemLista {
  return {
    id: n,
    nome: NOMES[n - 1] ?? `Jogador ${n}`,
    tipo: 'fixo',
    posicao: 'linha',
    jogadorId: n,
  };
}

/** Uma lista com `quantos` de linha, o ultimo deles convidado do primeiro. */
function lista(quantos: number): ItemLista[] {
  const itens = Array.from({ length: quantos }, (_, i) => fixo(i + 1));
  const ultimo = itens[quantos - 1];
  if (ultimo) {
    itens[quantos - 1] = {
      ...ultimo,
      tipo: 'convidado',
      nome: 'Pedrinho',
      convidadoDe: NOMES[0] ?? 'Fausto',
      convidadoDeId: 1,
    };
  }
  return itens;
}

const goleiros: ItemGoleiro[] = [
  { id: 900, nome: 'Zé Goleiro', contratado: true },
  { id: 901, nome: 'Lucas', contratado: false, convidadoDe: 'Alexson', convidadoDeId: 2 },
];

function bloco(titulo: string, texto: string): void {
  console.log(`\n${'═'.repeat(64)}\n  ${titulo}\n${'═'.repeat(64)}\n${texto}`);
}

// 1. Quarta 12:00
bloco('QUARTA 12:00 — abertura (mensagem + enquete)', mensagemAberturaFixos(partida));
console.log(`\n[enquete] ${tituloDaEnquete(partida.vagas_total)}`);
for (const o of OPCOES) console.log(`   ( ) ${o}`);

// 2. Lista cheia com fila
const cheia = lista(partida.vagas_total + 2);
const vagasCheia = contarVagas(cheia, partida.vagas_total);
bloco(
  'LISTA COM RESERVA (digest das 19:00)',
  [
    `📋 Como está a lista para ${rotuloData(dataJogo)}:`,
    '',
    formatarLista(partida, cheia, goleiros, config.RACHA_NOME),
    '',
    ...alertasDeVagas(vagasCheia, config.ALERTA_VAGAS),
    '',
    'Para entrar ou sair, responda na enquete do racha 👆',
  ].join('\n'),
);

// 3. Entrou na reserva
bloco(
  'ALGUÉM MARCA COM A LISTA CHEIA',
  '🪑 Otávio entrou na reserva (1º da fila). Se alguém sair, entra na hora.',
);

// 4. Saida com promocao: sai o 18o (Diego), sobe o 19o (Murilo) - a lista
// mostrada e a MESMA de cima, sem quem saiu.
const apos = cheia.filter((i) => i.nome !== 'Diego');
bloco(
  'UM CONVOCADO SAI — A RESERVA SOBE',
  [
    '❌ Diego não vai mais. Liberou vaga!',
    '✅ Murilo entrou no lugar, direto da reserva!',
    '',
    formatarLista(partida, apos, goleiros, config.RACHA_NOME),
    '',
    ...alertasDeVagas(contarVagas(apos, partida.vagas_total), config.ALERTA_VAGAS),
    '',
    'Para entrar ou sair, responda na enquete do racha 👆',
  ].join('\n'),
);

// 5. DM de quem subiu
bloco(
  'PRIVADO DE QUEM SUBIU',
  [
    `🎉 Abriu vaga e você entrou! Estava na reserva do racha de ${rotuloData(dataJogo)} e agora está escalado.`,
    '',
    'Se não der mais, responde "não vou mais" que eu passo a vaga pro próximo.',
    '',
    '(não quer que eu te chame? responde "não perturbe")',
  ].join('\n'),
);

process.exit(0);
