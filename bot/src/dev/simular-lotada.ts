/**
 * Ferramenta de TESTE (nao roda em producao).
 *
 * Enche a partida atual ate a vaga de linha, com jogadores ficticios, para
 * testar a trava de "lista completa" sem esperar 18 pessoas de verdade.
 * Preenche direto no banco, sem passar pelo grupo - silencioso de proposito,
 * senao seriam 18 anuncios de confirmacao.
 *
 * Uso, com a stack no ar e uma partida ja aberta (ex: apos simular-abertura.ts):
 *   docker compose exec bot npx tsx src/dev/simular-lotada.ts
 *
 * Depois, tocar "✅ Vou" na enquete do grupo com uma conta que ainda nao esta
 * na lista deve ser recusado, sem entrar - e o grupo deve ver o aviso de
 * recusa.
 */
import { pool } from '../db.js';
import { partidaAtual } from '../domain/partida.js';
import { confirmarFixo } from '../domain/inscricao.js';
import { resolver } from '../domain/jogador.js';

async function main(): Promise<void> {
  const partida = await partidaAtual();
  if (!partida) {
    console.error('nenhuma partida aberta. Rode simular-abertura.ts primeiro.');
    process.exit(1);
  }

  let entraram = 0;
  for (let i = 1; entraram < partida.vagas_total; i++) {
    const jogador = await resolver({
      telefone: `55999900${String(i).padStart(4, '0')}@s.whatsapp.net`,
      nome: `Fictício ${i}`,
    });
    const r = await confirmarFixo(partida, jogador.id, 'linha');
    if (r.ok && r.valor.novo) entraram++;
  }

  console.log(`lista preenchida: ${entraram}/${partida.vagas_total} de linha`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
