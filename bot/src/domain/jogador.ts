import type { PoolClient } from 'pg';
import { query, transaction } from '../db.js';

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
}

interface LinhaJogador {
  id: number;
  lid: string | null;
  telefone: string | null;
  nome: string;
  nome_confirmado: boolean;
  falou_no_privado: boolean;
  nao_perturbe: boolean;
}

const SELECT_JOGADOR = `
  id, lid, telefone,
  coalesce(nome_escolhido, nome) as nome,
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



