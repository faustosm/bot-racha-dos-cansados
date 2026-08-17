/**
 * Ferramenta manual (nao roda em producao/agendador).
 *
 * Manda UM convite individual de avaliacao (enquete 0-5) pro numero indicado,
 * criando o convite de verdade (`avaliacao`, com enquete_id/segredo) preso a
 * partida mais recente - assim, quando a pessoa votar, o webhook cai no MESMO
 * caminho de producao (`tratarVotoDeEnquete` -> `tratarVotoAvaliacao`).
 *
 * Dois usos:
 *  - validar a decifragem de enquete privada com um numero de teste (foi
 *    assim que a formula certa de JID/LID foi descoberta, ver server.ts);
 *  - mandar convite avulso pra alguem que ficou fora do envio automatico de
 *    `enviarConvitesDeAvaliacao` (ex.: goleiro/convidado, que nao tem
 *    jogador_id rastreavel na inscricao) quando faz sentido pontualmente -
 *    sem virar regra permanente de elegibilidade no scheduler.
 *
 * Uso, com a stack no ar:
 *   docker compose exec bot npx tsx src/dev/testar-avaliacao.ts <numero> [nome]
 *
 * Exemplo (DDI+DDD+numero, so digitos):
 *   docker compose exec bot npx tsx src/dev/testar-avaliacao.ts 5534991830259 Guilherme
 *
 * Depois de votar, confira:
 *   select * from avaliacao order by id desc limit 1;
 */
import { pool } from '../db.js';
import { sendPoll } from '../evolution/client.js';
import {
  OPCOES_AVALIACAO,
  criarConviteAvaliacao,
  tituloDaEnqueteAvaliacao,
} from '../domain/avaliacao.js';
import { partidaParaLeitura } from '../domain/partida.js';
import { resolver } from '../domain/jogador.js';

const numero = process.argv[2];
if (!numero || !/^\d+$/.test(numero)) {
  console.error('uso: npx tsx src/dev/testar-avaliacao.ts <numero, so digitos com DDI> [nome]');
  process.exit(1);
}
const nome = process.argv[3] ?? 'Teste avaliacao';

// jogador.telefone e sempre guardado com o sufixo (ver qualquer linha real
// da tabela) - sem isso o convite fica com um JID que nao bate com o resto.
const telefone = `${numero}@s.whatsapp.net`;

async function main(): Promise<void> {
  const partida = await partidaParaLeitura();
  if (!partida) throw new Error('nenhuma partida no banco - crie uma antes de testar');

  const jogador = await resolver({ telefone, nome });
  console.log('jogador:', { id: jogador.id, telefone, nome });
  console.log('partida:', { id: partida.id, data_jogo: partida.data_jogo });

  const enquete = await sendPoll(telefone, tituloDaEnqueteAvaliacao(), OPCOES_AVALIACAO);
  if (!enquete) {
    throw new Error('a enquete nao voltou com id/segredo - falha ao enviar');
  }

  await criarConviteAvaliacao(partida.id, jogador.id, enquete);
  console.log('convite enviado e gravado:', { enqueteId: enquete.id });
  console.log('vote na enquete que chegou no WhatsApp e depois confira:');
  console.log('  select * from avaliacao order by id desc limit 1;');
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
