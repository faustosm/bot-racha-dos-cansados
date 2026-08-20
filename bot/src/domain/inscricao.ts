import type { PoolClient } from 'pg';
import { query, queryOne, transaction } from '../db.js';
import { motivoDaRecusa, motivoRecusaGoleiro } from './lista.js';
import { erro, ok } from './tipos.js';
import type {
  ItemGoleiro,
  ItemLista,
  Partida,
  Posicao,
  Resultado,
} from './tipos.js';

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
     and i.posicao = 'linha'
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

/** So os jogadores de linha - goleiro tem lista propria, `listarGoleiros`. */
export async function listar(partidaId: number): Promise<ItemLista[]> {
  const rows = await query<LinhaLista>(SQL_LISTA, [partidaId]);
  return rows.map(paraItem);
}

interface LinhaGoleiro {
  id: number;
  nome: string;
  goleiro_contratado: boolean;
  convidado_de_nome: string | null;
  convidado_de_id: number | null;
}

const SQL_GOLEIROS = `
  select i.id,
         coalesce(j.nome_escolhido, j.nome, i.convidado_nome) as nome,
         i.goleiro_contratado,
         coalesce(jc.nome_escolhido, jc.nome) as convidado_de_nome,
         i.convidado_de_id as convidado_de_id
    from inscricao i
    left join jogador j  on j.id = i.jogador_id
    left join jogador jc on jc.id = i.convidado_de_id
   where i.partida_id = $1
     and i.removido_em is null
     and i.posicao = 'gol'
   order by i.criado_em, i.id
`;

export async function listarGoleiros(partidaId: number): Promise<ItemGoleiro[]> {
  const rows = await query<LinhaGoleiro>(SQL_GOLEIROS, [partidaId]);
  return rows.map((r) => ({
    id: r.id,
    nome: r.nome,
    contratado: r.goleiro_contratado,
    ...(r.convidado_de_nome ? { convidadoDe: r.convidado_de_nome } : {}),
    ...(r.convidado_de_id !== null ? { convidadoDeId: r.convidado_de_id } : {}),
  }));
}

export interface FixoConfirmado {
  readonly jogadorId: number;
  readonly telefone: string | null;
  readonly lid: string | null;
  readonly naoPerturbe: boolean;
}

const SQL_FIXOS_CONFIRMADOS = `
  select j.id as jogador_id, j.telefone, j.lid, j.nao_perturbe
    from inscricao i
    join jogador j on j.id = i.jogador_id
   where i.partida_id = $1
     and i.removido_em is null
     and i.tipo = 'fixo'
     and i.posicao = 'linha'
`;

/**
 * Quem efetivamente jogou, para a avaliacao pos-jogo (ver scheduler.ts,
 * `encerrarPartida`). Mesma fonte de verdade de `listar` (fixo de linha
 * confirmado) - so que aqui interessa telefone/lid/nao_perturbe da PESSOA,
 * nao o nome para exibir na lista.
 */
export async function listarFixosConfirmados(
  partidaId: number,
): Promise<FixoConfirmado[]> {
  const rows = await query<{
    jogador_id: number;
    telefone: string | null;
    lid: string | null;
    nao_perturbe: boolean;
  }>(SQL_FIXOS_CONFIRMADOS, [partidaId]);
  return rows.map((r) => ({
    jogadorId: r.jogador_id,
    telefone: r.telefone,
    lid: r.lid,
    naoPerturbe: r.nao_perturbe,
  }));
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
): Promise<{ linha: number; gols: number }> {
  await client.query('select id from partida where id = $1 for update', [
    partidaId,
  ]);
  const { rows } = await client.query<{ linha: string; gols: string }>(
    `select count(*) filter (where posicao = 'linha')::text as linha,
            count(*) filter (where posicao = 'gol')::text as gols
       from inscricao
      where partida_id = $1 and removido_em is null`,
    [partidaId],
  );
  return {
    linha: Number(rows[0]?.linha ?? 0),
    gols: Number(rows[0]?.gols ?? 0),
  };
}

/**
 * Mesma checagem de teto (goleiro ou linha, conforme a posicao de destino)
 * usada em toda entrada nova ou troca de posicao. Extraida porque ja
 * aconteceu de um site novo esquecer de aplica-la (a troca de posicao em
 * `confirmarFixo` so ganhou a checagem depois, retroativamente) - com um so
 * lugar, uma regra nova de elegibilidade nao pode deixar de valer em algum
 * dos pontos por esquecimento.
 */
function motivoDeCapacidade(
  contagem: { linha: number; gols: number },
  partida: Partida,
  posicao: Posicao,
): string | undefined {
  return posicao === 'gol'
    ? motivoRecusaGoleiro(contagem.gols, partida.vagas_goleiro)
    : motivoDaRecusa(contagem.linha, partida, 1);
}


export interface Confirmacao {
  readonly posicao: Posicao;
  /** Ja estava na lista, exatamente nesta posicao: nada mudou. */
  readonly jaEstava: boolean;
  /** Entrou agora. Falso quando apenas trocou de linha para gol ou vice-versa. */
  readonly novo: boolean;
  /**
   * Esta entrada foi a que fechou a lista de linha (contagem foi de
   * `vagas_total - 1` para `vagas_total`).
   *
   * Calculado aqui, na mesma contagem travada (`contarComLock`) que decide se
   * cabe - nunca a partir da coluna `status` da partida. `status` e so
   * bookkeeping (`sincronizarStatus` em handlers.ts) e pode ficar desalinhado
   * da ocupacao real quando uma inscricao e corrigida direto no banco (ja
   * aconteceu - ver nota em `iniciarConvidados`). Se o "lotou" confiasse em
   * `status <> 'cheia'` para decidir quem avisa, uma correcao manual que deixa
   * `status = 'cheia'` preso engole o aviso do proximo fechamento de verdade
   * em silencio.
   */
  readonly lotouAgora: boolean;
}

export async function confirmarFixo(
  partida: Partida,
  jogadorId: number,
  posicao: Posicao,
): Promise<Resultado<Confirmacao>> {
  return transaction(async (client) => {
    // Trava a partida ANTES de checar se o jogador ja esta inscrito: sem
    // isso, duas confirmacoes quase simultaneas do mesmo jogador (duplo
    // toque na enquete, webhook reentregue com outro id de mensagem) podem
    // ambas ler "nao existe" e ambas tentar inserir - a segunda bate na
    // constraint unica (inscricao_fixo_unica) e lanca erro nao tratado em vez
    // de responder "voce ja estava na lista". `contarComLock` trava a mesma
    // linha mais adiante; e reentrante dentro da mesma transacao.
    await client.query('select id from partida where id = $1 for update', [
      partida.id,
    ]);

    const atual = await client.query<{ id: number; posicao: Posicao }>(
      `select id, posicao from inscricao
        where partida_id = $1 and jogador_id = $2 and removido_em is null`,
      [partida.id, jogadorId],
    );

    const existente = atual.rows[0];
    if (existente) {
      if (existente.posicao === posicao) {
        return ok({ posicao, jaEstava: true, novo: false, lotouAgora: false });
      }
      // Troca de posicao: precisa caber no teto da posicao de DESTINO, seja
      // qual for - mesma checagem que toda entrada nova passa.
      const contagem = await contarComLock(client, partida.id);
      const motivoTroca = motivoDeCapacidade(contagem, partida, posicao);
      if (motivoTroca) return erro<Confirmacao>(motivoTroca);
      await client.query('update inscricao set posicao = $2 where id = $1', [
        existente.id,
        posicao,
      ]);
      // Trocou de posicao, mas ja estava na lista: quem chama nao deve
      // reperguntar sobre convidados nem repetir a conversa de boas-vindas.
      return ok({
        posicao,
        jaEstava: false,
        novo: false,
        lotouAgora: posicao === 'linha' && contagem.linha + 1 === partida.vagas_total,
      });
    }

    const contagem = await contarComLock(client, partida.id);
    const motivo = motivoDeCapacidade(contagem, partida, posicao);
    if (motivo) return erro<Confirmacao>(motivo);

    await client.query(
      `insert into inscricao (partida_id, tipo, posicao, jogador_id)
       values ($1, 'fixo', $2, $3)`,
      [partida.id, posicao, jogadorId],
    );
    return ok({
      posicao,
      jaEstava: false,
      novo: true,
      lotouAgora: posicao === 'linha' && contagem.linha + 1 === partida.vagas_total,
    });
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
      return erro<Desistencia>('Você não estava na lista.');
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
  opcoes: {
    // Falso apenas quando o anfitriao acabou de sair e esta decidindo se o
    // convidado fica: nesse caso ele nao esta mais na lista, de proposito.
    exigirAnfitriao?: boolean;
    // So faz sentido com posicao 'gol': contratado por fora, sem anfitriao de
    // verdade - `anfitriaoId` fica so como "quem avisou", nao dono do goleiro.
    contratado?: boolean;
  } = {},
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
          'Confirme sua presença antes de trazer convidado.',
        );
      }
    }

    const contagem = await contarComLock(client, partida.id);
    const motivo = motivoDeCapacidade(contagem, partida, posicao);
    if (motivo) return erro<ItemLista>(motivo);

    const { rows } = await client.query<{ id: number }>(
      `insert into inscricao
         (partida_id, tipo, posicao, convidado_nome, convidado_de_id, goleiro_contratado)
       values ($1, 'convidado', $2, $3, $4, $5)
       returning id`,
      [partida.id, posicao, nome, anfitriaoId, opcoes.contratado ?? false],
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

/** Como o pedido de remocao terminou, para quem chama montar a resposta. */
export type Remocao =
  | { readonly tipo: 'removido'; readonly nome: string }
  | { readonly tipo: 'sem_convidados' }
  | { readonly tipo: 'nao_encontrado'; readonly seus: readonly string[] }
  | { readonly tipo: 'ambiguo'; readonly nome: string; readonly quantos: number };

/**
 * Remove um convidado pelo NOME.
 *
 * Por nome, e nao por posicao numa lista numerada: a lista numerada existia so
 * para resolver nomes repetidos - um caso raro - e cobrava 4 mensagens de
 * todo mundo, sempre. Aqui o caso raro paga o proprio custo (o bot pede o nome
 * completo) e o caso comum resolve em uma mensagem.
 *
 * So mexe nos convidados de quem pediu: ninguem tira convidado alheio.
 */
export async function removerConvidado(
  partida: Partida,
  anfitriaoId: number,
  nome: string,
): Promise<Remocao> {
  return transaction(async (client) => {
    const { rows } = await client.query<{ id: number; convidado_nome: string }>(
      `select id, convidado_nome from inscricao
        where partida_id = $1 and convidado_de_id = $2 and removido_em is null
        order by criado_em, id`,
      [partida.id, anfitriaoId],
    );

    if (!rows.length) return { tipo: 'sem_convidados' };

    const alvo = normalizarNome(nome);
    const casam = rows.filter((r) => normalizarNome(r.convidado_nome) === alvo);

    if (!casam.length) {
      return {
        tipo: 'nao_encontrado',
        seus: rows.map((r) => r.convidado_nome),
      };
    }
    if (casam.length > 1) {
      return {
        tipo: 'ambiguo',
        nome: casam[0]?.convidado_nome ?? nome,
        quantos: casam.length,
      };
    }

    const unico = casam[0]!;
    await client.query('update inscricao set removido_em = now() where id = $1', [
      unico.id,
    ]);
    return { tipo: 'removido', nome: unico.convidado_nome };
  });
}

/** Compara nome sem depender de acento nem de caixa: "joao" acha "João". */
export function normalizarNome(n: string): string {
  return n
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
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
        'Essa inscrição não existe mais.',
      );
    }

    const contagem = await contarComLock(client, partida.id);
    const motivo = motivoDeCapacidade(contagem, partida, alvo.posicao);
    if (motivo) return erro<{ nome: string; posicao: Posicao }>(motivo);

    await client.query(
      'update inscricao set removido_em = null where id = $1',
      [inscricaoId],
    );
    return ok({ nome: alvo.convidado_nome ?? '?', posicao: alvo.posicao });
  });
}


