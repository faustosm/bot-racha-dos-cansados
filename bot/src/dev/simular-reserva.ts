/**
 * Ferramenta de TESTE (nao roda em producao).
 *
 * Exercita a reserva de ponta a ponta no banco, sem mandar nada no WhatsApp:
 * enche a lista, poe gente na reserva, tira alguem e mostra quem subiu e como
 * a lista sairia no grupo.
 *
 * Uso, com a stack no ar e uma partida aberta (ex: apos simular-abertura.ts):
 *   docker compose exec bot npx tsx src/dev/simular-reserva.ts
 *
 * Silencioso de proposito: imprime no terminal em vez de publicar. Quem quiser
 * ver no grupo de teste deve usar a enquete de verdade.
 */
import { pool } from '../db.js';
import { partidaAtual } from '../domain/partida.js';
import {
  confirmarFixo,
  desistir,
  listar,
  listarGoleiros,
  reservarVaga,
} from '../domain/inscricao.js';
import * as reserva from '../domain/reserva.js';
import { formatarLista, mensagemEntrouNaReserva } from '../domain/lista.js';
import { resolver } from '../domain/jogador.js';
import { config } from '../config.js';

async function main(): Promise<void> {
  const partida = await partidaAtual();
  if (!partida) {
    console.error('nenhuma partida aberta. Rode simular-abertura.ts primeiro.');
    process.exit(1);
  }

  // 1. enche a lista
  let entraram = 0;
  const dentro: number[] = [];
  for (let i = 1; entraram < partida.vagas_total; i++) {
    const j = await resolver({
      telefone: `55999900${String(i).padStart(4, '0')}@s.whatsapp.net`,
      nome: `Fictício ${i}`,
    });
    const r = await confirmarFixo(partida, j.id, 'linha');
    if (r.ok && r.valor.novo) {
      entraram++;
      dentro.push(j.id);
    }
  }
  console.log(`lista cheia: ${entraram}/${partida.vagas_total}`);

  // 2. tres pessoas tentam entrar e vao pra reserva
  const candidatos = [
    ['Reserva Um', false],
    ['Reserva Dois', true],
    ['Reserva Três', false],
  ] as const;
  for (const [i, [n, querConvidado]] of candidatos.entries()) {
    // Telefone derivado do INDICE, nunca do nome: derivar do nome ja fez dois
    // candidatos diferentes virarem a mesma pessoa (mesmo tamanho, mesma
    // ultima letra), e a simulacao mentiu sem parecer que mentia.
    const j = await resolver({
      telefone: `55999980${String(i + 1).padStart(3, '0')}@s.whatsapp.net`,
      nome: n,
    });
    const r = await reservarVaga(partida, j.id, querConvidado);
    console.log(
      r.tipo === 'reservado'
        ? `  ${mensagemEntrouNaReserva(n, r.posicao)}`
        : `  ${n}: ${r.tipo}`,
    );
  }

  // 3. alguem sai - a reserva deve subir sozinha, na ordem
  const saiu = dentro[0];
  if (saiu !== undefined) {
    const r = await desistir(partida, saiu);
    if (r.ok) {
      console.log(
        `\nsaiu 1 pessoa -> subiram: ${
          r.valor.promovidos.map((p) => p.nome).join(', ') || '(ninguém)'
        }`,
      );
    }
  }

  const [itens, goleiros, fila] = await Promise.all([
    listar(partida.id),
    listarGoleiros(partida.id),
    reserva.listar(partida.id),
  ]);
  console.log(`\n${formatarLista(partida, itens, goleiros, config.RACHA_NOME, fila)}`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
