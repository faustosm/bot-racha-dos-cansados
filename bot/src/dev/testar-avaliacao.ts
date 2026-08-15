/**
 * Ferramenta de TESTE (nao roda em producao).
 *
 * Manda UM convite individual de avaliacao (enquete 0-5) pro numero indicado,
 * criando o convite de verdade (`avaliacao`, com enquete_id/segredo) preso a
 * uma partida real - assim, quando a pessoa votar, o webhook cai no MESMO
 * caminho de producao (`tratarVotoDeEnquete` -> `tratarVotoAvaliacao`) e da
 * para conferir se a nota realmente grava.
 *
 * Existe especificamente para validar um ponto que nunca foi testado: se o
 * payload de voto de uma enquete PRIVADA decifra do mesmo jeito que a de
 * grupo (ver comentario em server.ts sobre isso).
 *
 * Uso, com a stack no ar:
 *   docker compose exec bot npx tsx src/dev/testar-avaliacao.ts <numero>
 *
 * Exemplo (DDI+DDD+numero, so digitos):
 *   docker compose exec bot npx tsx src/dev/testar-avaliacao.ts 5534991705227
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
  console.error('uso: npx tsx src/dev/testar-avaliacao.ts <numero, so digitos com DDI>');
  process.exit(1);
}

// jogador.telefone e sempre guardado com o sufixo (ver qualquer linha real
// da tabela) - sem isso o convite fica com um JID que nao bate com o resto.
const telefone = `${numero}@s.whatsapp.net`;

async function main(): Promise<void> {
  const partida = await partidaParaLeitura();
  if (!partida) throw new Error('nenhuma partida no banco - crie uma antes de testar');

  const jogador = await resolver({ telefone, nome: 'Teste avaliacao' });
  console.log('jogador de teste:', { id: jogador.id, telefone });
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
