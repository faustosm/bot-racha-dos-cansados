/**
 * Ferramenta de TESTE (nao roda em producao).
 *
 * Zera os dados do racha e simula a abertura da lista de quarta-feira, para dar
 * para testar o fluxo inteiro sem esperar o cron. Cria a partida do proximo
 * sabado com as janelas ajustadas para agora.
 *
 * Uso, com a stack no ar:
 *   docker compose exec bot npx tsx src/dev/simular-abertura.ts
 *
 * Convidados liberam alguns minutos depois de propósito: assim da para ver a
 * recusa "so a partir de quinta" antes e o fluxo de convidado depois.
 */
import { pool, query, queryOne } from '../db.js';
import { anunciarAberturaFixos, publicarEnquete } from '../scheduler.js';
import { proximoSabado } from '../domain/datas.js';
import { config } from '../config.js';
import type { Partida } from '../domain/tipos.js';

const MINUTOS_ATE_CONVIDADOS = Number(process.env.MIN_CONVIDADOS ?? '5');

const log = {
  info: (obj: unknown, msg: string) => console.log(msg, obj),
  warn: (obj: unknown, msg: string) => console.warn(msg, obj),
};

async function main(): Promise<void> {
  // 1. Zera. `partida` cascateia para inscricao e conversa.
  await query('delete from partida');
  await query('delete from jogador');
  console.log('dados zerados (partidas, inscricoes, conversas e jogadores)');

  // 2. Cria a partida do proximo sabado com a janela aberta agora.
  //
  // Nao da para usar garantirPartida(): hoje pode ser o proprio sabado, e ai as
  // janelas calculadas ficariam todas no passado e a lista nasceria fechada.
  const hoje = new Date();
  const amanha = new Date(hoje.getTime() + 24 * 3600_000);
  const dataJogo = proximoSabado(amanha);

  const partida = await queryOne<Partida>(
    `insert into partida
       (data_jogo, abre_fixos, abre_convidados, fecha_em, vagas_total, vagas_goleiro)
     values ($1,
             now() - interval '1 minute',
             now() + ($2 || ' minutes')::interval,
             now() + interval '7 days',
             $3, 0)
     returning id, data_jogo, abre_fixos, abre_convidados, fecha_em,
               vagas_total, vagas_goleiro, status`,
    [
      dataJogo,
      MINUTOS_ATE_CONVIDADOS,
      config.VAGAS_TOTAL,
    ],
  );
  if (!partida) throw new Error('falha ao criar a partida de teste');

  console.log('partida criada:', {
    data_jogo: partida.data_jogo,
    convidados_liberam_em: `${MINUTOS_ATE_CONVIDADOS} min`,
  });

  // 3. Dispara o mesmo anuncio e a mesma enquete do cron de quarta 12:00.
  await anunciarAberturaFixos(log, partida);
  await publicarEnquete(log, partida);
  console.log('anuncio e enquete enviados para o grupo');
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
