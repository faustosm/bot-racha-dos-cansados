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
  TipoInscricao,
} from './tipos.js';

/**
 * Alguem que passou a estar dentro das vagas quando outro saiu - a "promocao"
 * da reserva. Nao e um estado no banco: e so o resultado da comparacao feita
 * em `diferencaDeConvocados`.
 */
export interface Promovido {
  readonly inscricaoId: number;
  readonly nome: string;
  /** Id do jogador quando e um fixo; convidado nao tem cadastro proprio. */
  readonly jogadorId: number | null;
}

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

/**
 * Ja perguntamos pra essa pessoa se ela consegue um goleiro, nesta partida?
 *
 * Uma vez por pessoa por partida (ver `ofertarGoleiroSeNecessario` em
 * handlers.ts) - sem isso a pergunta repetiria a cada mensagem que a pessoa
 * mandasse, e goleiro em falta costuma durar dias (mesmo cuidado que
 * `alertasDeVagas`, em lista.ts, ja toma pra lista publicada no grupo).
 */
export async function jaOfertadoGoleiro(
  jogadorId: number,
  partidaId: number,
): Promise<boolean> {
  const r = await queryOne(
    `select 1 from goleiro_oferta where jogador_id = $1 and partida_id = $2`,
    [jogadorId, partidaId],
  );
  return r !== undefined;
}

/** Marca que a oferta ja foi feita, pra nao repetir. Idempotente. */
export async function marcarOfertaGoleiro(
  jogadorId: number,
  partidaId: number,
): Promise<void> {
  await query(
    `insert into goleiro_oferta (jogador_id, partida_id)
     values ($1, $2)
     on conflict (jogador_id, partida_id) do nothing`,
    [jogadorId, partidaId],
  );
}

export interface FixoConfirmado {
  readonly jogadorId: number;
  readonly telefone: string | null;
  readonly lid: string | null;
  readonly naoPerturbe: boolean;
}

const SQL_FIXOS_CONFIRMADOS = `
  with linha as (
    select i.id, i.tipo, i.jogador_id,
           row_number() over (order by i.criado_em, i.id) as pos
      from inscricao i
     where i.partida_id = $1
       and i.removido_em is null
       and i.posicao = 'linha'
  )
  select j.id as jogador_id, j.telefone, j.lid, j.nao_perturbe
    from linha l
    join jogador j on j.id = l.jogador_id
    join partida p on p.id = $1
   where l.tipo = 'fixo'
     and l.pos <= p.vagas_total
`;

/**
 * Quem efetivamente jogou, para a avaliacao pos-jogo (ver scheduler.ts,
 * `encerrarPartida`). Mesma fonte de verdade de `listar` (fixo de linha
 * confirmado) - so que aqui interessa telefone/lid/nao_perturbe da PESSOA,
 * nao o nome para exibir na lista.
 *
 * So os CONVOCADOS (`pos <= vagas_total`): quem ficou na reserva ate o fim
 * nao jogou, e pedir nota do jogo a quem nao jogou e tao errado quanto mandar
 * para quem saiu do grupo (ver `enviarConvitesDeAvaliacao`).
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
 *
 * Desde 21/09/2026 a linha nao tem teto para FIXO: passando das vagas ele
 * entra na reserva, em vez de ser recusado. Convidado continua limitado - e
 * limitado pela fila inteira, nao so pelas vagas (`motivoDaRecusa` conta a
 * reserva): a proxima vaga e de quem ja esta esperando.
 */
function motivoDeCapacidade(
  contagem: { linha: number; gols: number },
  partida: Partida,
  posicao: Posicao,
  tipo: TipoInscricao,
): string | undefined {
  if (posicao === 'gol') {
    return motivoRecusaGoleiro(contagem.gols, partida.vagas_goleiro);
  }
  if (tipo === 'fixo') return undefined;
  return motivoDaRecusa(contagem.linha, partida, 1);
}

/**
 * A posicao desta inscricao na fila da linha (1 = primeiro a confirmar).
 * Maior que `vagas_total` significa reserva.
 *
 * Calculada por `row_number` sobre a mesma ordem que a lista publicada usa
 * (`criado_em, id`), e nao guardada em coluna: assim ninguem precisa
 * "promover" ninguem no banco - sai um convocado, quem vinha atras ja e o
 * proximo, por construcao.
 */
async function posicaoNaLinha(
  client: PoolClient,
  partidaId: number,
  inscricaoId: number,
): Promise<number> {
  const { rows } = await client.query<{ pos: string }>(
    `select pos from (
       select id, row_number() over (order by criado_em, id) as pos
         from inscricao
        where partida_id = $1 and removido_em is null and posicao = 'linha'
     ) t where id = $2`,
    [partidaId, inscricaoId],
  );
  return Number(rows[0]?.pos ?? 0);
}

/** Quem esta DENTRO das vagas agora, na ordem. */
async function convocadosDaLinha(
  client: PoolClient,
  partida: Partida,
): Promise<Promovido[]> {
  const { rows } = await client.query<{
    id: number;
    nome: string;
    jogador_id: number | null;
  }>(
    `select i.id,
            coalesce(j.nome_escolhido, j.nome, i.convidado_nome) as nome,
            i.jogador_id
       from inscricao i
       left join jogador j on j.id = i.jogador_id
      where i.partida_id = $1
        and i.removido_em is null
        and i.posicao = 'linha'
      order by i.criado_em, i.id
      limit $2`,
    [partida.id, partida.vagas_total],
  );
  return rows.map((r) => ({
    inscricaoId: r.id,
    nome: r.nome,
    jogadorId: r.jogador_id,
  }));
}

/**
 * Quem passou a estar dentro das vagas por causa de uma saida.
 *
 * Comparar o conjunto de convocados ANTES e DEPOIS, em vez de "pegar o
 * primeiro da reserva", cobre de graca o caso em que uma saida so libera
 * VARIAS vagas: quem desiste leva os convidados junto, e ai sobe mais de uma
 * pessoa de uma vez.
 */
function diferencaDeConvocados(
  antes: readonly Promovido[],
  depois: readonly Promovido[],
): Promovido[] {
  const jaEstavam = new Set(antes.map((c) => c.inscricaoId));
  return depois.filter((c) => !jaEstavam.has(c.inscricaoId));
}


export interface Confirmacao {
  readonly posicao: Posicao;
  /**
   * Entrou (ou continua) FORA das vagas, na fila de espera.
   *
   * Fixo nunca e recusado desde 21/09/2026 - passando das vagas ele fica na
   * reserva e sobe sozinho quando alguem sai. Quem chama usa isto para dizer
   * a pessoa que ela ainda nao esta escalada: sem esse aviso, o voto marcado
   * na enquete faria ela achar que esta.
   */
  readonly reserva: boolean;
  /** 1 = proximo a entrar. Zero quando esta convocado. */
  readonly posicaoNaReserva: number;
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

/**
 * Traduz a posicao na fila em "esta na reserva?" + "que lugar?". Goleiro nao
 * tem fila: teto rigido, sem espera (ver `motivoRecusaGoleiro`).
 */
async function filaDe(
  client: PoolClient,
  partida: Partida,
  inscricaoId: number,
  posicao: Posicao,
): Promise<{ reserva: boolean; posicaoNaReserva: number }> {
  if (posicao !== 'linha') return { reserva: false, posicaoNaReserva: 0 };
  const pos = await posicaoNaLinha(client, partida.id, inscricaoId);
  return pos > partida.vagas_total
    ? { reserva: true, posicaoNaReserva: pos - partida.vagas_total }
    : { reserva: false, posicaoNaReserva: 0 };
}

/** A inscricao ativa da pessoa nesta partida, se houver. So leitura. */
export async function minhaInscricao(
  partidaId: number,
  jogadorId: number,
): Promise<{ posicao: Posicao } | undefined> {
  return queryOne<{ posicao: Posicao }>(
    `select posicao from inscricao
      where partida_id = $1 and jogador_id = $2 and removido_em is null`,
    [partidaId, jogadorId],
  );
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
        const fila = await filaDe(client, partida, existente.id, posicao);
        return ok({
          posicao,
          ...fila,
          jaEstava: true,
          novo: false,
          lotouAgora: false,
        });
      }
      // Troca de posicao: precisa caber no teto da posicao de DESTINO, seja
      // qual for - mesma checagem que toda entrada nova passa.
      const contagem = await contarComLock(client, partida.id);
      const motivoTroca = motivoDeCapacidade(contagem, partida, posicao, 'fixo');
      if (motivoTroca) return erro<Confirmacao>(motivoTroca);
      await client.query('update inscricao set posicao = $2 where id = $1', [
        existente.id,
        posicao,
      ]);
      // Trocou de posicao, mas ja estava na lista: quem chama nao deve
      // reperguntar sobre convidados nem repetir a conversa de boas-vindas.
      const fila = await filaDe(client, partida, existente.id, posicao);
      return ok({
        posicao,
        ...fila,
        jaEstava: false,
        novo: false,
        lotouAgora: posicao === 'linha' && contagem.linha + 1 === partida.vagas_total,
      });
    }

    const contagem = await contarComLock(client, partida.id);
    const motivo = motivoDeCapacidade(contagem, partida, posicao, 'fixo');
    if (motivo) return erro<Confirmacao>(motivo);

    const inserida = await client.query<{ id: number }>(
      `insert into inscricao (partida_id, tipo, posicao, jogador_id)
       values ($1, 'fixo', $2, $3)
       returning id`,
      [partida.id, posicao, jogadorId],
    );
    const fila = await filaDe(
      client,
      partida,
      inserida.rows[0]?.id ?? 0,
      posicao,
    );
    return ok({
      posicao,
      ...fila,
      jaEstava: false,
      novo: true,
      lotouAgora: posicao === 'linha' && contagem.linha + 1 === partida.vagas_total,
    });
  });
}

export interface Desistencia {
  /** Posicao de quem saiu. Goleiro saindo e o pior caso e merece alerta. */
  readonly posicao: Posicao;
  /**
   * A vaga dela era a UNICA fechada no teto da propria posicao (18 de linha,
   * ou vagas_goleiro de gol) - a saida agora abre a primeira vaga livre.
   *
   * Calculado ANTES de remover, na mesma contagem travada (`contarComLock`)
   * que toda entrada usa pra decidir se cabe - simetrico a `Confirmacao.lotouAgora`
   * e pelo mesmo motivo: se dependesse da coluna `status`, uma correcao manual
   * no banco que deixasse `status` desalinhado engoliria o aviso em silencio.
   *
   * Decisao de 11/09/2026: antes disso o aviso de saida saia so sexta/sabado
   * (`diaDeAvisarSaida`, removida) - so que uma saida de quinta a noite, DEPOIS
   * do digest das 19h, ficava sem aviso nenhum ate a proxima sexta, mesmo tendo
   * sido a vaga que destravou a lista pra quem estava esperando (caso do
   * Thiago Miranda, 10/09/2026). O sinal certo nao e o dia da semana, e ter
   * destravado ou nao - se a lista ja tinha vaga sobrando, ninguem tava
   * esperando, e o digest normal cobre.
   */
  readonly abriuVaga: boolean;
  /** Convidados que sairam junto - o bot pergunta depois se algum fica. */
  readonly convidados: readonly {
    id: number;
    nome: string;
    posicao: Posicao;
  }[];
  /**
   * Quem subiu da reserva por causa desta saida (pode ser mais de um quando
   * o anfitriao leva convidados junto). Vazio quando nao havia fila.
   */
  readonly promovidos: readonly Promovido[];
}

/** Sai da lista e leva junto os convidados que trouxe. */
export async function desistir(
  partida: Partida,
  jogadorId: number,
): Promise<Resultado<Desistencia>> {
  return transaction(async (client) => {
    // Conta ANTES de remover: depois da saida a contagem ja nao reflete mais
    // se a vaga dela era a ultima fechada.
    const antes = await contarComLock(client, partida.id);
    const convocadosAntes = await convocadosDaLinha(client, partida);

    const eu = await client.query<{ id: number; posicao: Posicao }>(
      `update inscricao set removido_em = now()
        where partida_id = $1 and jogador_id = $2 and removido_em is null
        returning id, posicao`,
      [partida.id, jogadorId],
    );
    const minhaInscricaoId = eu.rows[0]?.id;
    const minhaPosicao = eu.rows[0]?.posicao;
    if (!minhaPosicao || minhaInscricaoId === undefined) {
      return erro<Desistencia>('Você não estava na lista.');
    }

    const teto = minhaPosicao === 'gol' ? partida.vagas_goleiro : partida.vagas_total;
    const ocupadasAntes = minhaPosicao === 'gol' ? antes.gols : antes.linha;
    // Quem sai da RESERVA nao libera nada: ele nem estava escalado. Sem esta
    // checagem, uma desistencia no fim da fila geraria "liberou vaga!" no
    // grupo com a lista seguindo exatamente igual.
    const estavaEscalado =
      minhaPosicao === 'gol' ||
      convocadosAntes.some((c) => c.inscricaoId === minhaInscricaoId);
    const abriuVaga = estavaEscalado && teto > 0 && ocupadasAntes >= teto;

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
    // Depois de tudo removido (a pessoa e os convidados dela): quem entrou no
    // lugar. Calculado aqui dentro, na mesma transacao - fora dela outra
    // confirmacao poderia se meter no meio e o "entrou no lugar" apontaria
    // para a pessoa errada.
    const promovidos = diferencaDeConvocados(
      convocadosAntes,
      await convocadosDaLinha(client, partida),
    );

    return ok({
      posicao: minhaPosicao,
      abriuVaga,
      promovidos,
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
    const motivo = motivoDeCapacidade(contagem, partida, posicao, 'convidado');
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
  | {
      readonly tipo: 'removido';
      readonly nome: string;
      readonly posicao: Posicao;
      /** Mesmo calculo e mesmo motivo de `Desistencia.abriuVaga`. */
      readonly abriuVaga: boolean;
      /** Quem subiu da reserva no lugar dele. */
      readonly promovidos: readonly Promovido[];
    }
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
    // Conta ANTES de remover - mesmo motivo de `desistir`: depois da saida a
    // contagem ja nao reflete mais se a vaga dele era a ultima fechada.
    const antes = await contarComLock(client, partida.id);
    const convocadosAntes = await convocadosDaLinha(client, partida);
    const teto = unico.posicao === 'gol' ? partida.vagas_goleiro : partida.vagas_total;
    const ocupadasAntes = unico.posicao === 'gol' ? antes.gols : antes.linha;
    // Mesma regra de `desistir`: so libera vaga quem estava escalado.
    const estavaEscalado =
      unico.posicao === 'gol' ||
      convocadosAntes.some((c) => c.inscricaoId === unico.id);
    const abriuVaga = estavaEscalado && teto > 0 && ocupadasAntes >= teto;

    await client.query('update inscricao set removido_em = now() where id = $1', [
      unico.id,
    ]);
    const promovidos = diferencaDeConvocados(
      convocadosAntes,
      await convocadosDaLinha(client, partida),
    );
    return {
      tipo: 'removido',
      nome: unico.convidado_nome,
      posicao: unico.posicao,
      abriuVaga,
      promovidos,
    };
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

    // Convidado, mesmo voltando: nao fura fila. Se a lista de linha ja esta
    // cheia (com ou sem reserva atras), ele nao volta - a vaga seria de quem
    // esta esperando.
    const contagem = await contarComLock(client, partida.id);
    const motivo = motivoDeCapacidade(contagem, partida, alvo.posicao, 'convidado');
    if (motivo) return erro<{ nome: string; posicao: Posicao }>(motivo);

    await client.query(
      'update inscricao set removido_em = null where id = $1',
      [inscricaoId],
    );
    return ok({ nome: alvo.convidado_nome ?? '?', posicao: alvo.posicao });
  });
}


