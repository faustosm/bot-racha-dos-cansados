/**
 * Cadastra no app (rachadoscansados) quem acabou de entrar no grupo - ver
 * cadastro/fluxo.ts. Mesma conversa com o worker que sincronizar.ts: GET,
 * mexe so em `players`, PUT com baseVersion e um retry em 409.
 *
 * Nunca duplica: se ja existe alguem no app com esse telefone, nao cria nada
 * e devolve quem ja estava la.
 */
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getRacha, putRacha } from './client.js';
import {
  finalDoTelefone,
  jogadorDoAppPorTelefone,
  montarJogadorApp,
  nomeLivreNoApp,
  telefoneParaApp,
} from '../cadastro/respostas.js';

export interface NovoNoApp {
  readonly nome: string;
  readonly apelido: string | null;
  /** JID de telefone de quem entrou. */
  readonly telefone: string;
  /** JID de telefone de quem convidou, pra achar o id dele no app. */
  readonly convidadoPorTelefone: string | null;
}

export type ResultadoCadastroApp =
  | { status: 'criado'; nomeNoApp: string; convidadoPorNoApp: boolean }
  | { status: 'ja_existia'; nomeNoApp: string }
  | { status: 'desligado' }
  | { status: 'conflito' };

const MAX_TENTATIVAS = 2;

export async function cadastrarNoApp(novo: NovoNoApp): Promise<ResultadoCadastroApp> {
  if (!config.APP_SYNC_RACHA_ID || !config.APP_SYNC_EDIT_TOKEN) return { status: 'desligado' };

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    const leitura = await getRacha(config.APP_SYNC_URL, config.APP_SYNC_RACHA_ID, config.APP_SYNC_EDIT_TOKEN);
    const players = leitura.data.players ?? [];

    const existente = jogadorDoAppPorTelefone(players, novo.telefone);
    if (existente) return { status: 'ja_existia', nomeNoApp: existente.name ?? '?' };

    const anfitriao = jogadorDoAppPorTelefone(players, novo.convidadoPorTelefone);
    const configApp = (leitura.data.config ?? {}) as { perPlayerValue?: unknown };
    const nomeNoApp = nomeLivreNoApp(players, novo.nome, novo.apelido, finalDoTelefone(novo.telefone));

    const jogador = montarJogadorApp({
      id: randomUUID(),
      nome: nomeNoApp,
      apelido: novo.apelido,
      telefone: telefoneParaApp(novo.telefone),
      convidadoPor: anfitriao?.id ?? null,
      valorPorJogador: String(configApp.perPlayerValue ?? '0'),
    });

    const put = await putRacha(
      config.APP_SYNC_URL,
      config.APP_SYNC_RACHA_ID,
      config.APP_SYNC_EDIT_TOKEN,
      { ...leitura.data, players: [...players, jogador] },
      leitura.version,
    );
    if (put.ok) return { status: 'criado', nomeNoApp, convidadoPorNoApp: anfitriao !== undefined };
  }
  return { status: 'conflito' };
}
