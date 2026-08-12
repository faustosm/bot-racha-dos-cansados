/**
 * Ferramenta de TESTE (nao roda em producao).
 *
 * Monta uma lista fictícia e publica no grupo, para ver como o alerta aparece
 * sem precisar juntar 18 pessoas. Usa `formatarLista` e `alertasDeVagas` — as
 * mesmas funcoes do caminho real — entao o que sai aqui e o que sairia la.
 *
 * Uso, com a stack no ar:
 *   docker compose exec bot npx tsx src/dev/simular-alerta.ts completo
 *   docker compose exec bot npx tsx src/dev/simular-alerta.ts acabando
 *   docker compose exec bot npx tsx src/dev/simular-alerta.ts recusado
 */
import { pool } from '../db.js';
import { config } from '../config.js';
import { sendText } from '../evolution/client.js';
import {
  alertasDeVagas,
  contarVagas,
  formatarLista,
  motivoDaRecusa,
} from '../domain/lista.js';
import { proximoSabado } from '../domain/datas.js';
import type { ItemLista } from '../domain/tipos.js';

const NOMES = [
  'Fausto Soares', 'Joao', 'Pedro', 'Marcelo', 'Ana', 'Bia', 'Carlos',
  'Duda', 'Eduardo', 'Felipe', 'Gustavo', 'Henrique', 'Igor', 'Julio',
  'Kleber', 'Lucas', 'Mateus', 'Nelson', 'Otavio', 'Paulo',
];

function jogadores(quantos: number): ItemLista[] {
  return Array.from({ length: quantos }, (_, i) => ({
    id: i + 1,
    nome: NOMES[i % NOMES.length] ?? `Jogador ${i + 1}`,
    tipo: 'fixo' as const,
    posicao: 'linha' as const,
    jogadorId: i + 1,
  }));
}

const cenarios = {
  completo: {
    cabecalho: '✅ Paulo marcou que vai.',
    itens: jogadores(config.VAGAS_TOTAL),
  },
  acabando: {
    cabecalho: '✅ Otavio marcou que vai.',
    itens: jogadores(config.VAGAS_TOTAL - 2),
  },
  // Alguem tenta entrar com a lista ja cheia. O cabecalho sai do MESMO
  // `motivoDaRecusa` que o bot usa de verdade.
  recusado: {
    cabecalho: (() => {
      const partida = { vagas_total: config.VAGAS_TOTAL };
      const motivo = motivoDaRecusa(config.VAGAS_TOTAL, partida, 1);
      return `⚠️ Rafael: ${motivo}`;
    })(),
    itens: jogadores(config.VAGAS_TOTAL),
    // A recusa nao republica a lista: nada mudou, e cada tentativa depois de
    // lotar geraria mais uma copia identica no grupo. Este cenario existe
    // exatamente para mostrar a mensagem sozinha, como o bot manda.
    semLista: true,
  },
} as const;

async function main(): Promise<void> {
  const qual = (process.argv[2] ?? 'completo') as keyof typeof cenarios;
  const cenario = cenarios[qual];
  if (!cenario) {
    console.error(`cenario invalido. Use: ${Object.keys(cenarios).join(' | ')}`);
    process.exit(1);
  }

  const partida = {
    data_jogo: proximoSabado(new Date(Date.now() + 24 * 3600_000)),
    vagas_total: config.VAGAS_TOTAL,
  };

  const vagas = contarVagas(cenario.itens, partida.vagas_total);
  const alertas = alertasDeVagas(vagas, config.ALERTA_VAGAS);

  const semLista = 'semLista' in cenario && cenario.semLista === true;

  const texto = semLista
    ? ['🧪 SIMULAÇÃO', '', cenario.cabecalho].join('\n')
    : [
        '🧪 SIMULAÇÃO (lista fictícia, não vale nada)',
        '',
        cenario.cabecalho,
        '',
        formatarLista(partida, cenario.itens, config.RACHA_NOME),
        ...(alertas.length ? ['', ...alertas] : []),
      ].join('\n');

  console.log(texto);
  await sendText(config.GROUP_JID, texto);
  console.log('\n--- enviado para o grupo ---');
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
