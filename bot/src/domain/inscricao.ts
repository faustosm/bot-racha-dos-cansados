import type { PoolClient } from 'pg';
import { query, transaction } from '../db.js';
import { erro, ok } from './tipos.js';
import type { ItemLista, Partida, Posicao, Resultado } from './tipos.js';

interface LinhaLista {
  id: number;
  nome: string;
  tipo: 'fixo' | 'convidado';
  posicao: Posicao;
  convidado_de_nome: string | null;
  convidado_de_id: number | null;
  jogador_id: number | null;
}

const SQL_LISTA = `
  select i.id,
         coalesce(j.nome_escolhido, j.nome, i.convidado_nome) as nome,
         i.tipo,
         i.posicao,
         coalesce(jc.nome_escolhido, jc.nome) as convidado_de_nome,
         i.convidado_de_id  as convidado_de_id,
         i.jogador_id       as jogador_id
    from inscricao i
    left join jogador j  on j.id = i.jogador_id
    left join jogador jc on jc.id = i.convidado_de_id
   where i.partida_id = $1
     and i.removido_em is null
   order by i.criado_em, i.id
`;

function paraItem(r: LinhaLista): ItemLista {
  return {
    id: r.id,
    nome: r.nome,
    tipo: r.tipo,
    posicao: r.posicao,
    ...(r.jogador_id !== null ? { jogadorId: r.jogador_id } : {}),
    ...(r.convidado_de_nome ? { convidadoDe: r.convidado_de_nome } : {}),
    ...(r.convidado_de_id !== null ? { convidadoDeId: r.convidado_de_id } : {}),
  };
}

export async function listar(partidaId: number): Promise<ItemLista[]> {
  const rows = await query<LinhaLista>(SQL_LISTA, [partidaId]);
  return rows.map(paraItem);
}

/**
 * Trava a partida e conta as vagas ocupadas dentro da transacao.
 *
 * Sem o `for update`, dois "vou" simultaneos leem a mesma contagem, os dois
 * passam na checagem e a lista fecha com 21 pessoas.
 */
async function contarComLock(
  client: PoolClient,
  partidaId: number,
): Promise<{ total: number; gols: number }> {
  await client.query('select id from partida where id = $1 for update', [
    partidaId,
  ]);
  const { rows } = await client.query<{ total: string; gols: string }>(
    `select count(*)::text as total,
            count(*) filter (where posicao = 'gol')::text as gols
       from inscricao
      where partida_id = $1 and removido_em is null`,
    [partidaId],
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    gols: Number(rows[0]?.gols ?? 0),
  };
}

function recusa(
  contagem: { total: number; gols: number },
  partida: Partida,
  posicao: Posicao,
  quantas: number,
): string | undefined {
  if (contagem.total + quantas > partida.vagas_total) {
    return contagem.total >= partida.vagas_total
      ? 'A lista ja esta completa.'
      : `So resta${partida.vagas_total - contagem.total === 1 ? '' : 'm'} ${partida.vagas_total - contagem.total} vaga(s).`;
  }
  if (posicao === 'gol' && contagem.gols + quantas > partida.vagas_goleiro) {
    return `As ${partida.vagas_goleiro} vagas de goleiro ja estao ocupadas.`;
  }
  return undefined;
}

export interface Confirmacao {
  readonly posicao: Posicao;
  /** Ja estava na lista, exatamente nesta posicao: nada mudou. */
  readonly jaEstava: boolean;
  /** Entrou agora. Falso quando apenas trocou de linha para gol ou vice-versa. */
  readonly novo: boolean;
}

export async function confirmarFixo(
  partida: Partida,
  jogadorId: number,
  posicao: Posicao,
): Promise<Resultado<Confirmacao>> {
  return transaction(async (client) => {
    const atual = await client.query<{ id: number; posicao: Posicao }>(
      `select id, posicao from inscricao
        where partida_id = $1 and jogador_id = $2 and removido_em is null`,
      [partida.id, jogadorId],
    );

    const existente = atual.rows[0];
    if (existente) {
      if (existente.posicao === posicao) {
        return ok({ posicao, jaEstava: true, novo: false });
      }
      // Troca de posicao: precisa caber no teto de goleiros da nova posicao.
      const contagem = await contarComLock(client, partida.id);
      if (posicao === 'gol' && contagem.gols >= partida.vagas_goleiro) {
        return erro<Confirmacao>(
          `As ${partida.vagas_goleiro} vagas de goleiro ja estao ocupadas.`,
        );
      }
      await client.query('update inscricao set posicao = $2 where id = $1', [
        existente.id,
        posicao,
      ]);
      // Trocou de posicao, mas ja estava na lista: quem chama nao deve
      // reperguntar sobre convidados nem repetir a conversa de boas-vindas.
      return ok({ posicao, jaEstava: false, novo: false });
    }

    const contagem = await contarComLock(client, partida.id);
    const motivo = recusa(contagem, partida, posicao, 1);
    if (motivo) return erro<Confirmacao>(motivo);

    await client.query(
      `insert into inscricao (partida_id, tipo, posicao, jogador_id)
       values ($1, 'fixo', $2, $3)`,
      [partida.id, posicao, jogadorId],
    );
    return ok({ posicao, jaEstava: false, novo: true });
  });
}

export interface Desistencia {
  /** Posicao de quem saiu. Goleiro saindo e o pior caso e merece alerta. */
  readonly posicao: Posicao;
  /** Convidados que sairam junto - o bot pergunta depois se algum fica. */
  readonly convidados: readonly {
    id: number;
    nome: string;
    posicao: Posicao;
  }[];
}

/** Sai da lista e leva junto os convidados que trouxe. */
export async function desistir(
  partida: Partida,
  jogadorId: number,
): Promise<Resultado<Desistencia>> {
  return transaction(async (client) => {
    const eu = await client.query<{ posicao: Posicao }>(
      `update inscricao set removido_em = now()
        where partida_id = $1 and jogador_id = $2 and removido_em is null
        returning posicao`,
      [partida.id, jogadorId],
    );
    const minhaPosicao = eu.rows[0]?.posicao;
    if (!minhaPosicao) {
      return erro<Desistencia>('Voce nao estava na lista.');
    }

    // Saem junto por padrao: e o desfecho mais provavel, e libera vaga na
    // hora. O bot pergunta em seguida se algum deles vai mesmo assim - assim,
    // se a pessoa nao responder, a lista fica correta em vez de guardar vaga
    // para quem provavelmente nao vem.
    const convidados = await client.query<{
      id: number;
      convidado_nome: string;
      posicao: Posicao;
    }>(
      `update inscricao set removido_em = now()
        where partida_id = $1 and convidado_de_id = $2 and removido_em is null
        returning id, convidado_nome, posicao`,
      [partida.id, jogadorId],
    );
    return ok({
      posicao: minhaPosicao,
      convidados: convidados.rows.map((r) => ({
        id: r.id,
        nome: r.convidado_nome,
        posicao: r.posicao,
      })),
    });
  });
}

export async function adicionarConvidado(
  partida: Partida,
  anfitriaoId: number,
  nome: string,
  posicao: Posicao,
  // Falso apenas quando o anfitriao acabou de sair e esta decidindo se o
  // convidado fica: nesse caso ele nao esta mais na lista, de proposito.
  opcoes: { exigirAnfitriao?: boolean } = {},
): Promise<Resultado<ItemLista>> {
  return transaction(async (client) => {
    if (opcoes.exigirAnfitriao !== false) {
      const anfitriao = await client.query(
        `select 1 from inscricao
          where partida_id = $1 and jogador_id = $2 and removido_em is null`,
        [partida.id, anfitriaoId],
      );
      if (anfitriao.rowCount === 0) {
        return erro<ItemLista>(
          'Confirme sua presenca antes de trazer convidado.',
        );
      }
    }

    const contagem = await contarComLock(client, partida.id);
    const motivo = recusa(contagem, partida, posicao, 1);
    if (motivo) return erro<ItemLista>(motivo);

    const { rows } = await client.query<{ id: number }>(
      `insert into inscricao
         (partida_id, tipo, posicao, convidado_nome, convidado_de_id)
       values ($1, 'convidado', $2, $3, $4)
       returning id`,
      [partida.id, posicao, nome, anfitriaoId],
    );
    return ok({
      id: rows[0]?.id ?? 0,
      nome,
      tipo: 'convidado' as const,
      posicao,
      convidadoDeId: anfitriaoId,
    });
  });
}

/**
 * Remove o N-esimo convidado do jogador (1-based), na mesma ordem que o bot
 * mostra. Por numero e nao por nome: dois convidados podem se chamar "Joao".
 */
export async function removerConvidado(
  partida: Partida,
  anfitriaoId: number,
  indice: number,
): Promise<Resultado<{ nome: string; posicao: Posicao }>> {
  return transaction(async (client) => {
    const { rows } = await client.query<{
      id: number;
      convidado_nome: string;
      posicao: Posicao;
    }>(
      `select id, convidado_nome, posicao from inscricao
        where partida_id = $1 and convidado_de_id = $2 and removido_em is null
        order by criado_em, id`,
      [partida.id, anfitriaoId],
    );

    if (!rows.length) {
      return erro<{ nome: string; posicao: Posicao }>(
        'Voce nao tem convidados nesta lista.',
      );
    }
    const alvo = rows[indice - 1];
    if (!alvo) {
      return erro<{ nome: string; posicao: Posicao }>(
        `Voce tem ${rows.length} convidado(s). Escolha um numero entre 1 e ${rows.length}.`,
      );
    }

    await client.query(
      'update inscricao set removido_em = now() where id = $1',
      [alvo.id],
    );
    return ok({ nome: alvo.convidado_nome, posicao: alvo.posicao });
  });
}

/**
 * Desfaz a remocao de uma inscricao, preservando o `criado_em`.
 *
 * Usado quando o anfitriao sai mas o convidado vai mesmo assim. Inserir de novo
 * seria mais simples, mas jogaria a pessoa para o fim da lista - e a ordem de
 * chegada e o controle que o grupo usa para saber quem entrou primeiro.
 */
export async function restaurarInscricao(
  partida: Partida,
  inscricaoId: number,
): Promise<Resultado<{ nome: string; posicao: Posicao }>> {
  return transaction(async (client) => {
    const { rows } = await client.query<{
      convidado_nome: string | null;
      posicao: Posicao;
    }>(
      `select convidado_nome, posicao from inscricao
        where id = $1 and partida_id = $2 and removido_em is not null`,
      [inscricaoId, partida.id],
    );
    const alvo = rows[0];
    if (!alvo) {
      return erro<{ nome: string; posicao: Posicao }>(
        'Essa inscricao nao existe mais.',
      );
    }

    const contagem = await contarComLock(client, partida.id);
    const motivo = recusa(contagem, partida, alvo.posicao, 1);
    if (motivo) return erro<{ nome: string; posicao: Posicao }>(motivo);

    await client.query(
      'update inscricao set removido_em = null where id = $1',
      [inscricaoId],
    );
    return ok({ nome: alvo.convidado_nome ?? '?', posicao: alvo.posicao });
  });
}
