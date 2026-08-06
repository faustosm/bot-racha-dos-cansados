import { config } from './config.js';

/**
 * Link que abre a conversa privada com o bot, com a mensagem ja preenchida.
 *
 * E como as pessoas comecam a falar com o bot: um toque no link do anuncio,
 * sem salvar contato nem procurar numero. O caminho inverso - o bot puxar
 * conversa com quem nunca falou com ele - e o padrao classico de banimento e
 * por isso nao existe no codigo.
 *
 * Devolve string vazia se BOT_NUMERO nao estiver configurado, para o anuncio
 * simplesmente omitir o link em vez de mostrar um link quebrado.
 */
export function linkBot(textoPreenchido: string): string {
  if (!config.BOT_NUMERO) return '';
  return `https://wa.me/${config.BOT_NUMERO}?text=${encodeURIComponent(textoPreenchido)}`;
}

/** Linha de instrucao para os anuncios, com ou sem link. */
export function comoFalarComOBot(exemplo = 'vou no racha'): string {
  const link = linkBot(exemplo);
  return link
    ? `Responda no meu privado: ${link}`
    : 'Me chame no privado para confirmar (toque no meu nome aqui no grupo).';
}
