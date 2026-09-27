/**
 * Ferramenta de TESTE do cadastro de quem entra no grupo (cadastro/fluxo.ts),
 * sem precisar de alguem entrar de verdade.
 *
 * Manda as perguntas do cadastro pro telefone informado, como se a pessoa
 * tivesse acabado de entrar. A pessoa responde pelo WhatsApp e o bot no ar
 * segue o fluxo normal: enquete de posicao, "quem convidou", aviso ao comite e
 * cadastro no app (quem ja esta no app nao e duplicado - so aparece "ja estava
 * cadastrado" no aviso). Precisa ser alguem que o bot ja conhece.
 *
 * Uso, com a stack no ar:
 *   docker compose exec bot npx tsx src/dev/testar-cadastro.ts 5534XXXXXXXXX
 */
import { pool } from '../db.js';
import { iniciarCadastroDeTeste } from '../cadastro/fluxo.js';

const numero = (process.argv[2] ?? '').replace(/\D/g, '');
if (!numero) {
  console.error('uso: npx tsx src/dev/testar-cadastro.ts 5534XXXXXXXXX');
  process.exit(1);
}

const log = { info: console.log, warn: console.warn };
const ok = await iniciarCadastroDeTeste(log, `${numero}@s.whatsapp.net`);
console.log(ok ? 'perguntas enviadas - responde pelo WhatsApp' : 'esse telefone nao e jogador conhecido do bot');
await pool.end();
