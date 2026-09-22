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
  motivoRecusaConvidado,
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
  // Fixo marcando presenca com a lista ja cheia: ele NAO e recusado, entra na
  // reserva. E a linha unica que o bot manda no grupo nesse caso.
  reserva: {
    cabecalho: '🪑 Rafael entrou na reserva (1º da fila). Se alguém sair, entra na hora.',
    itens: jogadores(config.VAGAS_TOTAL),
    // O aviso de reserva nao republica a lista: a fila costuma receber varias
    // pessoas seguidas, e uma lista inteira por reserva viraria mural de bot.
    semLista: true,
  },
  // Convidado recusado - nao mais por falta de vaga (com a fila formada ele
  // entra na reserva como qualquer um), e sim por ja ter usado a cota do
  // padrinho. O cabecalho sai do MESMO `motivoRecusaConvidado` que o bot usa.
  recusado: {
    cabecalho: (() => {
      const motivo = motivoRecusaConvidado(
        config.MAX_CONVIDADOS_POR_FIXO,
        config.MAX_CONVIDADOS_POR_FIXO,
      );
      return `⚠️ Rafael: ${motivo}`;
    })(),
    itens: jogadores(config.VAGAS_TOTAL + 2),
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
