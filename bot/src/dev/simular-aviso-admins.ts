/**
 * Ferramenta de TESTE (nao roda em producao).
 *
 * Dispara o aviso de quarta 11:59 na hora, sem esperar o cron: manda a
 * mensagem no grupo de GRUPO_ADMIN_JID e enfileira o lembrete no privado de
 * cada participante dele.
 *
 * Nao apaga nada (ao contrario de simular-abertura.ts) - so envia.
 *
 * Uso, com a stack no ar. Comece por um grupo de teste, para nao acordar o
 * comite inteiro:
 *
 *   docker compose exec -e GRUPO_ADMIN_JID=120363...@g.us \
 *     bot npx tsx src/dev/simular-aviso-admins.ts
 *
 * Sem o -e, usa o GRUPO_ADMIN_JID do .env (o comite de verdade).
 *
 * Fora de uma quarta 11:59 a lista da semana ja esta aberta, e o aviso ("daqui
 * a pouco abre") seria mentira - por isso o simulador ignora essa guarda, que
 * no cron de verdade continua valendo.
 */
import { pool } from '../db.js';
import { config } from '../config.js';
import { avisarAberturaAosAdmins } from '../scheduler.js';
import { tamanhoDaFila } from '../fila.js';

const log = {
  info: (obj: unknown, msg: string) => console.log(msg, obj),
  warn: (obj: unknown, msg: string) => console.warn(msg, obj),
};

async function main(): Promise<void> {
  if (!config.GRUPO_ADMIN_JID) {
    console.error(
      'GRUPO_ADMIN_JID vazio: configure no .env ou passe com -e no docker compose exec.',
    );
    process.exit(1);
  }

  console.log('grupo:', config.GRUPO_ADMIN_JID);
  await avisarAberturaAosAdmins(log, { mesmoComListaAberta: true });

  // A fila espaca os envios (4s por mensagem, ver fila.ts). Sem esperar, o
  // processo terminaria antes de a maioria dos privados sair.
  while (tamanhoDaFila() > 0) {
    console.log('na fila:', tamanhoDaFila());
    await new Promise((r) => setTimeout(r, 2000));
  }
  // O ultimo item sai da fila ANTES de ser enviado: uma folga final evita
  // encerrar o processo no meio do envio dele.
  await new Promise((r) => setTimeout(r, 5000));
  console.log('fila vazia, tudo enviado');
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
