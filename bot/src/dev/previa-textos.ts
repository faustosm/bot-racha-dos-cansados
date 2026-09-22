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
import {
  alertasDeVagas,
  contarVagas,
  formatarLista,
  rotuloData,
  textoDePromocao,
} from '../domain/lista.js';
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

// 5. DM de quem subiu - montada pela MESMA funcao que o bot usa.
const RODAPE_PROMOCAO = '(não quer que eu te chame? responde "não perturbe")';
const avisoDePromocao = (quem: {
  eu: boolean;
  convidados: string[];
}): string =>
  [...textoDePromocao(quem, rotuloData(dataJogo)), '', RODAPE_PROMOCAO].join(
    '\n',
  );

bloco(
  'PRIVADO DE QUEM SUBIU',
  avisoDePromocao({ eu: true, convidados: [] }),
);

// 6. Convidado entrando com a lista ja cheia - o padrinho precisa saber que
// ele caiu na fila, nao entre os 18 (correcao de 22/09/2026).
bloco(
  'CONVIDADO ENTRA COM A LISTA CHEIA — PRIVADO DO PADRINHO',
  [
    'Anotado: Pedrinho 🪑 (reserva, 2º da fila).',
    'As vagas de linha já estão ocupadas — se alguém sair, ele entra e eu te aviso aqui.',
  ].join('\n'),
);
bloco(
  'CONVIDADO ENTRA COM A LISTA CHEIA — ANÚNCIO NO GRUPO',
  '👥 Fausto confirmou convidado: Pedrinho 🪑 (reserva, 2º da fila).',
);

// 7. O convidado sobe: quem recebe o aviso e o PADRINHO, que e quem vai
// leva-lo no sabado - o convidado nao tem WhatsApp cadastrado.
bloco(
  'CONVIDADO SOBE DA RESERVA — PRIVADO DO PADRINHO',
  avisoDePromocao({ eu: false, convidados: ['Pedrinho'] }),
);

// 8. Os dois de uma vez (uma saida que liberou duas vagas): UMA mensagem so.
bloco(
  'PADRINHO E CONVIDADO SOBEM JUNTOS — UMA MENSAGEM SÓ',
  avisoDePromocao({ eu: true, convidados: ['Pedrinho'] }),
);

process.exit(0);
