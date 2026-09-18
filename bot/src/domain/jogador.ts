import type { PoolClient } from 'pg';
import { query, queryOne, transaction } from '../db.js';
// Uma unica regra de "mesmo nome" no projeto: a que ja decide se um
// convidado casa com o nome digitado (`removerConvidado`).
import { normalizarNome } from './inscricao.js';

// A mesma pessoa aparece com identificadores diferentes conforme o canal:
//
//   grupo   -> key.participant = @lid          + key.participantAlt = telefone
//   privado -> key.remoteJid   = telefone      + key.remoteJidAlt   = @lid
//
// Este modulo transforma qualquer combinacao dos dois num unico jogador.

export interface Identidade {
  readonly lid?: string | undefined;
  readonly telefone?: string | undefined;
  readonly nome: string;
  /** Verdadeiro quando esta mensagem veio do privado. Nunca volta para falso. */
  readonly noPrivado?: boolean;
}

export interface Jogador {
  readonly id: number;
  readonly lid: string | null;
  readonly telefone: string | null;
  /** Como a pessoa aparece na lista: o nome escolhido, ou o pushName. */
  readonly nome: string;
  /**
   * A pessoa ja escreveu para o bot no privado?
   *
   * E a permissao social para o bot escrever de volta. Quem entrou na lista so
   * por reacao no grupo nunca falou com ele - mandar DM ai seria puxar conversa
   * com desconhecido, que e o que derruba o numero.
   */
  readonly falouNoPrivado: boolean;
  /**
   * Pediu para o bot parar de puxar conversa por conta propria.
   *
   * Nao afeta resposta a quem escreveu - so o que o bot INICIA (fila.ts).
   */
  readonly naoPerturbe: boolean;
}

interface LinhaJogador {
  id: number;
  lid: string | null;
  telefone: string | null;
  nome: string;
  /** A coluna bruta (pushName), sem o coalesce com nome_escolhido - so para
   * comparar com o pushName recebido e saber se o UPDATE e mesmo necessario. */
  nome_bruto: string;
  nome_confirmado: boolean;
  falou_no_privado: boolean;
  nao_perturbe: boolean;
}

const SELECT_JOGADOR = `
  id, lid, telefone,
  coalesce(nome_escolhido, nome) as nome,
  nome as nome_bruto,
  nome_confirmado,
  falou_no_privado,
  nao_perturbe
`;

const paraJogador = (r: LinhaJogador): Jogador => ({
  id: r.id,
  lid: r.lid,
  telefone: r.telefone,
  nome: r.nome,
  falouNoPrivado: r.falou_no_privado,
  naoPerturbe: r.nao_perturbe,
});

/**
 * Funde dois cadastros da mesma pessoa num so.
 *
 * Acontece quando o bot conheceu alguem pelo telefone (falou no privado antes)
 * e depois pelo LID (falou no grupo). Sobrevive o cadastro mais antigo.
 */
async function fundir(
  client: PoolClient,
  vencedor: LinhaJogador,
  perdedor: LinhaJogador,
): Promise<void> {
  // Se os dois estao inscritos na mesma partida, a do perdedor sairia como
  // duplicata e violaria o indice unico. Marca como removida antes de mover.
  await client.query(
    `update inscricao i set removido_em = now()
      where i.jogador_id = $1 and i.tipo = 'fixo' and i.removido_em is null
        and exists (
          select 1 from inscricao b
           where b.partida_id = i.partida_id and b.jogador_id = $2
             and b.tipo = 'fixo' and b.removido_em is null)`,
    [perdedor.id, vencedor.id],
  );

  await client.query(
    'update inscricao set jogador_id = $2 where jogador_id = $1',
    [perdedor.id, vencedor.id],
  );
  await client.query(
    'update inscricao set convidado_de_id = $2 where convidado_de_id = $1',
    [perdedor.id, vencedor.id],
  );
  // Mesmo cuidado da inscricao, agora na reserva: `reserva` tem cascade para
  // `jogador`, entao sem mover as linhas o DELETE abaixo apagaria o lugar do
  // perdedor na fila EM SILENCIO - a pessoa sumiria da reserva sem ninguem
  // perceber. E se os dois cadastros estiverem na mesma reserva, mover direto
  // violaria `reserva_jogador_unica`: o do perdedor sai antes.
  await client.query(
    `update reserva r set saiu_em = now(), motivo_saida = 'desistiu'
      where r.jogador_id = $1 and r.saiu_em is null
        and exists (
          select 1 from reserva b
           where b.partida_id = r.partida_id and b.jogador_id = $2
             and b.saiu_em is null)`,
    [perdedor.id, vencedor.id],
  );
  await client.query('update reserva set jogador_id = $2 where jogador_id = $1', [
    perdedor.id,
    vencedor.id,
  ]);

  // Conversa e efemera: descartar e mais simples que resolver o conflito de PK.
  await client.query('delete from conversa where jogador_id = $1', [
    perdedor.id,
  ]);
  await client.query('delete from jogador where id = $1', [perdedor.id]);
}

/**
 * Devolve o jogador correspondente a essa identidade, criando ou completando
 * o cadastro conforme o necessario. Idempotente.
 */
export async function resolver(id: Identidade): Promise<Jogador> {
  const lid = id.lid ?? null;
  const telefone = id.telefone ?? null;
  const nome = id.nome || lid || telefone || 'desconhecido';

  if (!lid && !telefone) {
    throw new Error('identidade sem lid e sem telefone');
  }

  return transaction(async (client) => {
    // Trava por identidade ANTES de checar se o jogador ja existe: sem isso,
    // duas chamadas quase simultaneas para uma pessoa nova (ex.: um webhook
    // reentregue com outro id de mensagem) podem ambas ver 0 linhas e ambas
    // tentar o INSERT - a segunda bate em jogador.lid/telefone (unique) e
    // lanca erro nao tratado, e o evento e descartado em silencio. A trava e
    // liberada sozinha no commit/rollback da transacao (xact).
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [
      `${lid ?? ''}|${telefone ?? ''}`,
    ]);

    const { rows } = await client.query<LinhaJogador>(
      `select ${SELECT_JOGADOR} from jogador
        where ($1::text is not null and lid = $1)
           or ($2::text is not null and telefone = $2)
        order by id`,
      [lid, telefone],
    );

    if (rows.length === 0) {
      const criado = await client.query<LinhaJogador>(
        `insert into jogador (lid, telefone, nome, falou_no_privado)
         values ($1, $2, $3, $4)
         returning ${SELECT_JOGADOR}`,
        [lid, telefone, nome, id.noPrivado === true],
      );
      const j = criado.rows[0];
      if (!j) throw new Error('falha ao criar jogador');
      return paraJogador(j);
    }

    const vencedor = rows[0];
    if (!vencedor) throw new Error('resultado vazio apos length > 0');

    for (const perdedor of rows.slice(1)) {
      await fundir(client, vencedor, perdedor);
    }

    // Nada mudaria: pula a escrita. `resolver` roda em toda mensagem e todo
    // voto (inclusive leituras puras, como "lista") - sem este atalho, cada
    // uma dessas chamadas abre uma transacao de escrita a toa contra
    // `jogador`.
    const semMudanca =
      (lid === null || vencedor.lid === lid) &&
      (telefone === null || vencedor.telefone === telefone) &&
      vencedor.nome_bruto === nome &&
      (vencedor.falou_no_privado || id.noPrivado !== true);
    if (semMudanca) return paraJogador(vencedor);

    // Completa o identificador que faltava e atualiza o pushName. O
    // nome_escolhido nao e tocado: ele vence o pushName para sempre.
    const atualizado = await client.query<LinhaJogador>(
      `update jogador
          set lid      = coalesce(lid, $2),
              telefone = coalesce(telefone, $3),
              nome     = $4,
              -- so soma permissao, nunca tira: quem ja falou uma vez continua
              -- podendo ser respondido no privado.
              falou_no_privado = falou_no_privado or $5
        where id = $1
        returning ${SELECT_JOGADOR}`,
      [vencedor.id, lid, telefone, nome, id.noPrivado === true],
    );
    const j = atualizado.rows[0];
    return j ? paraJogador(j) : paraJogador(vencedor);
  });
}

/**
 * Busca um jogador pelo id - usado pelo cron de aviso de expiracao
 * (scheduler.ts), que so tem o `jogador_id` guardado na conversa e precisa do
 * telefone e de `naoPerturbe` pra decidir se manda o aviso.
 */
export async function buscarPorId(jogadorId: number): Promise<Jogador | undefined> {
  const r = await queryOne<LinhaJogador>(
    `select ${SELECT_JOGADOR} from jogador where id = $1`,
    [jogadorId],
  );
  return r ? paraJogador(r) : undefined;
}

/**
 * Busca um jogador pelo telefone, SEM criar nem atualizar cadastro.
 *
 * Existe separada de `resolver` de proposito: aquela e a porta de entrada de
 * quem mandou mensagem e, por isso, escreve no banco. Aqui o telefone veio da
 * lista de participantes de um grupo (o aviso de abertura, em scheduler.ts) e
 * a unica pergunta e se essa pessoa ja pediu silencio - consultar nao pode
 * virar cadastro novo.
 */
export async function buscarPorTelefone(
  telefone: string,
): Promise<Jogador | undefined> {
  const r = await queryOne<LinhaJogador>(
    `select ${SELECT_JOGADOR} from jogador where telefone = $1`,
    [telefone],
  );
  return r ? paraJogador(r) : undefined;
}

/** Liga/desliga a valvula de escape das mensagens que o bot inicia. */
export async function definirNaoPerturbe(
  jogadorId: number,
  valor: boolean,
): Promise<void> {
  await query('update jogador set nao_perturbe = $2 where id = $1', [
    jogadorId,
    valor,
  ]);
}

export interface JogadorEncontrado {
  readonly id: number;
  /** Como ele aparece na lista (nome escolhido, ou o pushName). */
  readonly nome: string;
}

/**
 * Procura cadastros pelo nome que aparece na lista.
 *
 * Em memoria, e nao em SQL, por causa do acento: "jose" tem que achar "José",
 * e o `like` do Postgres nao normaliza (unaccent nao esta instalada). Sao
 * algumas dezenas de cadastros - o custo e irrelevante, e a regra de
 * comparacao fica sendo a MESMA de `removerConvidado` (`normalizarNome`), em
 * vez de uma segunda definicao de "mesmo nome" no projeto.
 *
 * Match exato primeiro: quem se chama "Tiago" nao pode virar ambiguo so
 * porque existe um "Tiago Juliano" no grupo.
 */
export async function buscarPorNome(termo: string): Promise<JogadorEncontrado[]> {
  const alvo = normalizarNome(termo);
  if (!alvo) return [];

  const rows = await query<JogadorEncontrado>(
    `select id, coalesce(nome_escolhido, nome) as nome
       from jogador
      order by nome`,
  );

  const exatos = rows.filter((r) => normalizarNome(r.nome) === alvo);
  if (exatos.length) return exatos;

  return rows.filter((r) => normalizarNome(r.nome).includes(alvo));
}
