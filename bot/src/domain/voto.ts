import crypto from 'node:crypto';

// Decifra o voto de uma enquete do WhatsApp.
//
// A Evolution entrega o voto CIFRADO (`encPayload` + `encIv`) e nao decifra:
// e o bug conhecido em grupos com LID. Como o webhook nos entrega todas as
// pecas, fazemos aqui.
//
// A receita foi verificada contra um voto real deste grupo (ver voto.test.ts):
//
//   sign   = idDaEnquete ‖ jidDoCriador ‖ jidDoVotante ‖ "Poll Vote" ‖ 0x01
//   key0   = HMAC-SHA256(chave = 32 zeros, dados = messageSecret)
//   decKey = HMAC-SHA256(chave = key0,     dados = sign)
//   aad    = idDaEnquete ‖ 0x00 ‖ jidDoVotante
//   claro  = AES-256-GCM(encPayload, decKey, encIv, aad)
//
// ATENCAO AOS JIDs: a documentacao da comunidade diz para usar o formato
// telefone (@s.whatsapp.net). Num grupo com LID isso NAO funciona - testamos as
// quatro combinacoes e so LID/LID decifra. E exatamente por isso que a
// implementacao oficial do Baileys falha nesses grupos.

export interface VotoCifrado {
  readonly encPayload: Uint8Array;
  readonly encIv: Uint8Array;
}

export interface ContextoDoVoto {
  /** Id da mensagem da enquete. */
  readonly enqueteId: string;
  /** JID de quem criou a enquete (o bot), no formato @lid. */
  readonly criadorJid: string;
  /** JID de quem votou, no formato @lid. */
  readonly votanteJid: string;
  /** `messageSecret` devolvido na criacao da enquete. */
  readonly segredo: Uint8Array;
}

const hmac = (dados: Uint8Array, chave: Uint8Array): Buffer =>
  crypto.createHmac('sha256', chave).update(dados).digest();

/**
 * Devolve os hashes SHA-256 das opcoes escolhidas, ou undefined se nao
 * conseguir decifrar (voto de outra enquete, segredo errado, formato mudou).
 *
 * Nao lanca: voto que nao decifra e um evento a ignorar, nao uma falha do bot.
 */
export function decifrarVoto(
  voto: VotoCifrado,
  ctx: ContextoDoVoto,
): string[] | undefined {
  try {
    const sign = Buffer.concat([
      Buffer.from(ctx.enqueteId, 'utf8'),
      Buffer.from(ctx.criadorJid, 'utf8'),
      Buffer.from(ctx.votanteJid, 'utf8'),
      Buffer.from('Poll Vote', 'utf8'),
      Buffer.from([1]),
    ]);

    const key0 = hmac(Buffer.from(ctx.segredo), Buffer.alloc(32));
    const decKey = hmac(sign, key0);
    // Separador e o byte NULO. Escrito assim, e nao como template string com
    // o caractere no meio, porque caractere invisivel em string e bug
    // esperando acontecer: some numa copia e ninguem descobre por que parou.
    const aad = Buffer.concat([
      Buffer.from(ctx.enqueteId, 'utf8'),
      Buffer.from([0]),
      Buffer.from(ctx.votanteJid, 'utf8'),
    ]);

    const dados = Buffer.from(voto.encPayload);
    if (dados.length <= 16) return undefined;
    const corpo = dados.subarray(0, dados.length - 16);
    const tag = dados.subarray(dados.length - 16);

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      decKey,
      Buffer.from(voto.encIv),
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const claro = Buffer.concat([decipher.update(corpo), decipher.final()]);

    return lerOpcoesSelecionadas(claro);
  } catch {
    return undefined;
  }
}

/**
 * PollVoteMessage e um protobuf minusculo: campo 1, `repeated bytes
 * selectedOptions`. Ler na mao evita somar uma dependencia de protobuf ao
 * projeto so por causa de 15 linhas.
 */
function lerOpcoesSelecionadas(buf: Buffer): string[] {
  const hashes: string[] = [];
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i++];
    if (tag !== 0x0a) break; // campo 1, wire type 2 (length-delimited)

    let tamanho = 0;
    let deslocamento = 0;
    while (i < buf.length) {
      const b = buf[i++];
      if (b === undefined) return hashes;
      tamanho |= (b & 0x7f) << deslocamento;
      if ((b & 0x80) === 0) break;
      deslocamento += 7;
    }

    if (tamanho <= 0 || i + tamanho > buf.length) break;
    hashes.push(buf.subarray(i, i + tamanho).toString('hex'));
    i += tamanho;
  }
  return hashes;
}

/** O voto identifica a opcao pelo SHA-256 do texto exato dela. */
export function hashDaOpcao(texto: string): string {
  return crypto.createHash('sha256').update(texto, 'utf8').digest('hex');
}

/**
 * Casa os hashes do voto com a lista de opcoes enviada.
 * Voto vazio (a pessoa desmarcou tudo) devolve lista vazia.
 */
export function opcoesEscolhidas(
  hashes: readonly string[],
  opcoes: readonly string[],
): string[] {
  const porHash = new Map(opcoes.map((o) => [hashDaOpcao(o), o]));
  return hashes
    .map((h) => porHash.get(h))
    .filter((o): o is string => o !== undefined);
}
