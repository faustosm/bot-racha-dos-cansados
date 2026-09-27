/**
 * Cadastro de quem entra no grupo (27/09/2026).
 *
 * Alguem entra no GROUP_JID -> o bot manda no privado 4 perguntas, uma por
 * vez: nome, apelido, posicao (enquete de um toque, com texto de reserva) e
 * quem convidou. No fim grava o nome no jogador, cadastra no app como
 * convidado (app-sync/cadastrar.ts) e avisa o comite.
 *
 * E o unico lugar em que o bot escreve primeiro para quem NUNCA falou com
 * ele - o padrao que derruba numero (ver migration 004). Por isso: so com
 * CADASTRO_AO_ENTRAR ligado, uma unica mensagem inicial pela fila espacada,
 * nenhuma cobranca se a pessoa nao responder (o prazo fecha em silencio), e
 * nunca de novo para a mesma pessoa (uma linha em cadastro_novo para sempre).
 */
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { fetchGroupParticipants, sendPoll, sendText } from '../evolution/client.js';
import { enfileirar } from '../fila.js';
import { buscarPorId, buscarPorNome, buscarPorTelefone, resolver } from '../domain/jogador.js';
import { cadastrarNoApp, type ResultadoCadastroApp } from '../app-sync/cadastrar.js';
import { normalizar } from '../commands/parse.js';
import {
  OPCOES_POSICAO,
  ehNinguem,
  finalDoTelefone,
  interpretarApelido,
  interpretarNome,
  interpretarPosicao,
  type Posicao,
} from './respostas.js';

interface Log {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
}

type Etapa = 'nome' | 'apelido' | 'posicao' | 'convidou' | 'escolhendo_convidou' | 'concluido';

interface Candidato {
  readonly id: number;
  readonly nome: string;
}

interface LinhaCadastro {
  jogador_id: number;
  etapa: Etapa;
  nome: string | null;
  apelido: string | null;
  posicao: Posicao | null;
  convidado_por_id: number | null;
  convidado_por_texto: string | null;
  candidatos: Candidato[] | null;
  enquete_segredo: string | null;
}

/** Quantos candidatos a "quem convidou" o bot lista antes de desistir de listar. */
const MAX_CANDIDATOS = 5;

async function carregar(jogadorId: number): Promise<LinhaCadastro | undefined> {
  return queryOne<LinhaCadastro>(
    `select jogador_id, etapa, nome, apelido, posicao, convidado_por_id,
            convidado_por_texto, candidatos, enquete_segredo
       from cadastro_novo
      where jogador_id = $1 and concluido_em is null`,
    [jogadorId],
  );
}

async function atualizar(jogadorId: number, campos: Record<string, unknown>): Promise<void> {
  const nomes = Object.keys(campos);
  const sets = nomes.map((c, i) => `${c} = $${i + 2}`).join(', ');
  await query(
    `update cadastro_novo set ${sets}, atualizado_em = now() where jogador_id = $1`,
    [jogadorId, ...nomes.map((c) => campos[c])],
  );
}

async function responder(log: Log, jid: string, texto: string): Promise<void> {
  await sendText(jid, texto).catch((err) => log.warn({ err, jid }, 'falha ao responder no cadastro'));
}

// ---------------------------------------------------------------------------
// Entrada: alguem entrou no grupo
// ---------------------------------------------------------------------------

export interface Entrou {
  readonly lid?: string | undefined;
  readonly telefone?: string | undefined;
  /** Nome do perfil, quando a Evolution manda. */
  readonly nomePerfil?: string | undefined;
}

/**
 * O webhook as vezes traz so o @lid. A lista de participantes tem o par
 * lid/telefone de todo mundo - inclusive de quem acabou de entrar.
 */
async function completarTelefone(log: Log, e: Entrou): Promise<string | undefined> {
  if (e.telefone) return e.telefone;
  if (!e.lid || !config.GROUP_JID) return undefined;
  const participantes = await fetchGroupParticipants(config.GROUP_JID).catch((err) => {
    log.warn({ err }, 'falha ao buscar participantes pra achar o telefone de quem entrou');
    return [];
  });
  return participantes.find((p) => p.lid === e.lid)?.telefone;
}

export async function aoEntrarNoGrupo(log: Log, e: Entrou): Promise<void> {
  if (!config.CADASTRO_AO_ENTRAR) return;

  const telefone = await completarTelefone(log, e);
  if (!telefone) {
    log.warn({ lid: e.lid }, 'entrou no grupo sem telefone conhecido - cadastro nao iniciado');
    return;
  }
  if (config.BOT_NUMERO && telefone === `${config.BOT_NUMERO}@s.whatsapp.net`) return;

  // Quem o bot ja conhece (saiu e voltou, ou ja falou com ele) nao recebe
  // questionario: ja esta na base.
  if (await buscarPorTelefone(telefone)) {
    log.info({ telefone }, 'entrou no grupo mas ja e conhecido - sem cadastro');
    return;
  }

  const jogador = await resolver({
    lid: e.lid,
    telefone,
    nome: e.nomePerfil || finalDoTelefone(telefone),
    noPrivado: false,
  });

  const criado = await queryOne<{ jogador_id: number }>(
    `insert into cadastro_novo (jogador_id, etapa) values ($1, 'nome')
     on conflict (jogador_id) do nothing
     returning jogador_id`,
    [jogador.id],
  );
  if (!criado) return;

  log.info({ jogadorId: jogador.id }, 'novo no grupo: cadastro iniciado');
  enfileirar(log, { tipo: 'texto', para: telefone, texto: boasVindas() });
}

const boasVindas = () =>
  [
    `Fala! 👋 Sou o bot do ${config.RACHA_NOME}. Vi que você entrou no grupo, seja bem-vindo!`,
    '',
    'Pra te cadastrar no racha são 4 perguntas rápidas.',
    '',
    '*Qual seu nome?* (do jeito que vai aparecer na lista)',
  ].join('\n');

/**
 * Teste de ponta a ponta sem ninguem entrar no grupo (src/dev/testar-cadastro.ts):
 * abre o questionario pra alguem que JA e jogador, como se tivesse acabado de
 * entrar. Apaga o cadastro anterior dessa pessoa, pra poder repetir o teste.
 * Funciona com CADASTRO_AO_ENTRAR desligado - a chave so controla o disparo
 * automatico na entrada.
 */
export async function iniciarCadastroDeTeste(log: Log, telefone: string): Promise<boolean> {
  const jogador = await buscarPorTelefone(telefone);
  if (!jogador) return false;
  await query('delete from cadastro_novo where jogador_id = $1', [jogador.id]);
  await query(`insert into cadastro_novo (jogador_id, etapa) values ($1, 'nome')`, [jogador.id]);
  await sendText(telefone, boasVindas());
  log.info({ jogadorId: jogador.id }, 'cadastro de teste iniciado');
  return true;
}

// ---------------------------------------------------------------------------
// Respostas no privado
// ---------------------------------------------------------------------------

export interface MensagemCadastro {
  readonly jogadorId: number;
  readonly jidPrivado: string;
  readonly texto: string;
  readonly log: Log;
}

/**
 * Trata a mensagem se a pessoa esta no meio do cadastro. Devolve `false` se
 * nao ha cadastro em andamento - ai a mensagem segue o caminho normal.
 */
export async function continuarCadastro(m: MensagemCadastro): Promise<boolean> {
  // Sem checar CADASTRO_AO_ENTRAR: so existe cadastro em andamento se ele foi
  // aberto (pela entrada no grupo, com a chave ligada, ou pelo teste).
  const c = await carregar(m.jogadorId);
  if (!c) return false;

  switch (c.etapa) {
    case 'nome':
      await etapaNome(m);
      return true;
    case 'apelido':
      await etapaApelido(m, c);
      return true;
    case 'posicao': {
      const p = interpretarPosicao(m.texto);
      if (!p) {
        await responder(m.log, m.jidPrivado, 'Responde *linha* ou *goleiro* (ou toca na enquete aí em cima).');
        return true;
      }
      await registrarPosicao(m.log, m.jogadorId, m.jidPrivado, p);
      return true;
    }
    case 'convidou':
      await etapaConvidou(m);
      return true;
    case 'escolhendo_convidou':
      await etapaEscolhendo(m, c);
      return true;
    default:
      return false;
  }
}

async function etapaNome(m: MensagemCadastro): Promise<void> {
  const nome = interpretarNome(m.texto);
  if (!nome) {
    await responder(m.log, m.jidPrivado, 'Manda só o seu nome, tipo *João Silva*.');
    return;
  }
  await atualizar(m.jogadorId, { nome, etapa: 'apelido' });
  await responder(
    m.log,
    m.jidPrivado,
    `Valeu, ${nome}! *Tem apelido no racha?* Se não tiver, manda *pular*.`,
  );
}

async function etapaApelido(m: MensagemCadastro, c: LinhaCadastro): Promise<void> {
  const apelido = interpretarApelido(m.texto);
  await atualizar(m.jogadorId, { apelido, etapa: 'posicao' });

  const enquete = await sendPoll(m.jidPrivado, 'Você joga de quê?', OPCOES_POSICAO).catch((err) => {
    m.log.warn({ err }, 'falha ao mandar enquete de posicao do cadastro');
    return undefined;
  });
  if (enquete) {
    await atualizar(m.jogadorId, { enquete_id: enquete.id, enquete_segredo: enquete.segredoBase64 });
    return;
  }
  // Sem enquete, a pergunta vai em texto - interpretarPosicao aceita os dois.
  await responder(m.log, m.jidPrivado, `${c.nome ?? 'Beleza'}, *você joga na linha ou no gol?*`);
}

/** Posicao chegou (voto na enquete ou texto). Ignora se a etapa ja passou. */
export async function registrarPosicao(
  log: Log,
  jogadorId: number,
  jidPrivado: string,
  posicao: Posicao,
): Promise<void> {
  const c = await carregar(jogadorId);
  if (!c || c.etapa !== 'posicao') return;
  await atualizar(jogadorId, { posicao, etapa: 'convidou' });
  await responder(
    log,
    jidPrivado,
    'Última: *quem te convidou pro racha?* Manda o nome dele como aparece no grupo (ou *ninguém*).',
  );
}

async function etapaConvidou(m: MensagemCadastro): Promise<void> {
  if (ehNinguem(m.texto)) {
    await concluir(m.log, m.jogadorId, true);
    return;
  }

  const candidatos = (await buscarPorNome(m.texto)).filter((j) => j.id !== m.jogadorId);

  if (candidatos.length === 0 || candidatos.length > MAX_CANDIDATOS) {
    // Nao achou (ou achou gente demais): guarda o que a pessoa escreveu e o
    // comite resolve no app. Melhor que prender a pessoa num vai-e-volta.
    await atualizar(m.jogadorId, { convidado_por_texto: m.texto.trim().slice(0, 60) });
    await concluir(m.log, m.jogadorId, true);
    return;
  }

  await atualizar(m.jogadorId, {
    etapa: 'escolhendo_convidou',
    candidatos: JSON.stringify(candidatos),
    convidado_por_texto: m.texto.trim().slice(0, 60),
  });

  const [unico] = candidatos;
  if (candidatos.length === 1 && unico) {
    await responder(m.log, m.jidPrivado, `É o *${unico.nome}*? Responde *sim* ou *não*.`);
    return;
  }
  await responder(
    m.log,
    m.jidPrivado,
    [
      'Qual deles? Responde o número:',
      '',
      ...candidatos.map((j, i) => `${i + 1}. ${j.nome}`),
      '',
      'Se não for nenhum, manda *nenhum*.',
    ].join('\n'),
  );
}

const SIM = new Set(['sim', 's', 'isso', 'e', 'e ele', 'eh', 'ele mesmo', 'esse', 'isso mesmo', 'yes']);
const NAO = new Set(['nao', 'n', 'nao e', 'nenhum', 'nenhum deles', 'outro']);

async function etapaEscolhendo(m: MensagemCadastro, c: LinhaCadastro): Promise<void> {
  const candidatos = c.candidatos ?? [];
  const t = normalizar(m.texto);

  let escolhido: Candidato | undefined;
  if (candidatos.length === 1 && SIM.has(t)) escolhido = candidatos[0];
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= candidatos.length) escolhido = candidatos[n - 1];

  if (escolhido) {
    await atualizar(m.jogadorId, { convidado_por_id: escolhido.id, convidado_por_texto: null });
    await concluir(m.log, m.jogadorId, true);
    return;
  }

  if (NAO.has(t)) {
    // Fica o texto que a pessoa digitou; o comite ajusta no app.
    await concluir(m.log, m.jogadorId, true);
    return;
  }

  await responder(
    m.log,
    m.jidPrivado,
    candidatos.length === 1 ? 'Responde *sim* ou *não*.' : 'Responde o número da lista, ou *nenhum*.',
  );
}

// ---------------------------------------------------------------------------
// Fechamento
// ---------------------------------------------------------------------------

/**
 * Fecha o cadastro: grava o nome escolhido, cadastra no app e avisa o comite.
 * `completo` = a pessoa respondeu tudo; `false` quando venceu o prazo.
 */
async function concluir(log: Log, jogadorId: number, completo: boolean): Promise<void> {
  // Marca concluido ANTES de falar com o app: se duas mensagens chegarem
  // juntas, so uma passa daqui.
  const c = await queryOne<LinhaCadastro>(
    `update cadastro_novo
        set etapa = 'concluido', concluido_em = now(), completo = $2, atualizado_em = now()
      where jogador_id = $1 and concluido_em is null
      returning jogador_id, etapa, nome, apelido, posicao, convidado_por_id,
                convidado_por_texto, candidatos, enquete_segredo`,
    [jogadorId, completo],
  );
  if (!c) return;

  const jogador = await buscarPorId(jogadorId);
  if (!jogador?.telefone) return;

  // O nome dito pela pessoa vence o pushName para sempre (migration 003).
  if (c.nome) {
    await query(
      'update jogador set nome_escolhido = $2, nome_confirmado = true where id = $1',
      [jogadorId, c.nome],
    );
  }
  const nome = c.nome ?? `Novo (final ${finalDoTelefone(jogador.telefone)})`;
  const anfitriao = c.convidado_por_id ? await buscarPorId(c.convidado_por_id) : undefined;

  const app: ResultadoCadastroApp | { status: 'falhou' } = await cadastrarNoApp({
    nome,
    apelido: c.apelido,
    telefone: jogador.telefone,
    convidadoPorTelefone: anfitriao?.telefone ?? null,
  }).catch((err) => {
    log.warn({ err, jogadorId }, 'falha ao cadastrar novo membro no app');
    return { status: 'falhou' as const };
  });

  log.info({ jogadorId, completo, app: app.status }, 'cadastro de novo membro concluido');

  if (completo) {
    await responder(
      log,
      jogador.telefone,
      `Pronto, ${nome}, tá cadastrado! ✅\n\nQuando a lista abrir, é só votar na enquete do grupo. Qualquer dúvida, me manda *ajuda*.`,
    );
  }

  await avisarComite(log, { c, nome, completo, anfitriao: anfitriao?.nome, app });
}

async function avisarComite(
  log: Log,
  a: {
    c: LinhaCadastro;
    nome: string;
    completo: boolean;
    anfitriao: string | undefined;
    app: ResultadoCadastroApp | { status: 'falhou' };
  },
): Promise<void> {
  if (!config.GRUPO_ADMIN_JID) return;

  const convidou = a.anfitriao ?? (a.c.convidado_por_texto ? `"${a.c.convidado_por_texto}" (não achei no grupo)` : '—');
  const noApp = {
    criado: 'cadastrado como *convidado*, nível "Grupo ?" — ajusta se precisar',
    ja_existia: 'já estava cadastrado, não mexi',
    desligado: 'sincronização com o app desligada, cadastra na mão',
    conflito: 'não consegui gravar (app sendo editado), cadastra na mão',
    falhou: 'deu erro ao gravar, cadastra na mão',
  }[a.app.status];

  const titulo = a.completo
    ? `🆕 Novo no grupo: *${a.nome}*${a.c.apelido ? ` (${a.c.apelido})` : ''}`
    : `🆕 Entrou no grupo e não terminou o cadastro: *${a.nome}*`;

  const texto = [
    titulo,
    `Posição: ${a.c.posicao ?? '—'}`,
    `Convidado por: ${convidou}`,
    `No app: ${noApp}`,
  ].join('\n');

  await sendText(config.GRUPO_ADMIN_JID, texto).catch((err) =>
    log.warn({ err }, 'falha ao avisar o comite sobre novo membro'),
  );
}

// ---------------------------------------------------------------------------
// Enquete de posicao e prazo
// ---------------------------------------------------------------------------

/** Cadastro dono dessa enquete de posicao, se for uma. */
export async function cadastroPorEnquete(
  enqueteId: string,
): Promise<{ jogadorId: number; segredo: string } | undefined> {
  const r = await queryOne<{ jogador_id: number; enquete_segredo: string }>(
    `select jogador_id, enquete_segredo from cadastro_novo
      where enquete_id = $1 and enquete_segredo is not null`,
    [enqueteId],
  );
  return r ? { jogadorId: r.jogador_id, segredo: r.enquete_segredo } : undefined;
}

/**
 * Fecha, em silencio para a pessoa, os cadastros parados ha mais de
 * CADASTRO_PRAZO_HORAS. Roda de hora em hora (scheduler.ts). Nao cobra
 * resposta: insistir com quem nao respondeu e o que vira denuncia.
 */
export async function fecharCadastrosVencidos(log: Log): Promise<void> {
  const vencidos = await query<{ jogador_id: number }>(
    `select jogador_id from cadastro_novo
      where concluido_em is null
        and atualizado_em < now() - ($1 || ' hours')::interval`,
    [config.CADASTRO_PRAZO_HORAS],
  );
  for (const v of vencidos) await concluir(log, v.jogador_id, false);
}
