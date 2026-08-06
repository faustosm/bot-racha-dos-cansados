import { z } from 'zod';

// Valida as variaveis de ambiente no boot e falha rapido se faltar alguma.
// Melhor quebrar em 2 segundos com mensagem clara do que 20 minutos depois
// com um "undefined" no meio de uma chamada HTTP.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production']).default('production'),
  BOT_PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  DATABASE_URL: z.string().url(),

  EVOLUTION_URL: z.string().url(),
  EVOLUTION_API_KEY: z.string().min(1, 'EVOLUTION_API_KEY nao pode ser vazio'),
  EVOLUTION_INSTANCE: z.string().min(1),

  WEBHOOK_TOKEN: z.string().min(1, 'WEBHOOK_TOKEN nao pode ser vazio'),

  // Vazio e valido: no primeiro boot ainda nao sabemos o JID do grupo.
  // O bot loga o JID de qualquer grupo que receber mensagem para voce copiar.
  GROUP_JID: z.string().default(''),

  // --- Identidade do racha (aparece na enquete e nos anuncios) --------------
  RACHA_NOME: z.string().default('Racha'),
  RACHA_LOCAL: z.string().default(''),
  RACHA_ENDERECO: z.string().default(''),
  RACHA_HORARIO: z.string().default('09:00 as 11:00'),

  // --- Regras do racha -----------------------------------------------------
  VAGAS_TOTAL: z.coerce.number().int().positive().default(20),
  // Teto de goleiros, nao cota reservada: com 1 goleiro cabem 19 de linha.
  VAGAS_GOLEIRO: z.coerce.number().int().nonnegative().default(2),

  // Cron do agendador (horario local do container, TZ=America/Sao_Paulo).
  CRON_ABRE_FIXOS: z.string().default('0 12 * * 3'), // quarta 12:00
  CRON_ABRE_CONVIDADOS: z.string().default('0 12 * * 4'), // quinta 12:00
  CRON_FECHA: z.string().default('0 7 * * 6'), // sabado 07:00 - fecha a lista
  CRON_ENCERRA: z.string().default('0 12 * * 6'), // sabado 12:00 - fim do racha
  CRON_CHAMADA: z.string().default('0 8 * * 5'), // sexta 08:00 - chamada geral

  // Quando avisar que as vagas estao acabando.
  ALERTA_VAGAS: z.coerce.number().int().nonnegative().default(2),
  // Minimo para o jogo acontecer. Abaixo disso, a chamada de sexta dispara.
  MIN_JOGADORES: z.coerce.number().int().positive().default(12),
  MIN_GOLEIROS: z.coerce.number().int().nonnegative().default(2),

  // Quanto tempo uma pergunta do bot fica valida no privado. Sem isso, um "3"
  // respondido tres dias depois viraria convidado fantasma.
  CONVERSA_TTL_MIN: z.coerce.number().int().positive().default(15),

  // Numero do bot, so digitos com DDI (ex: 553497062526). Usado para montar o
  // link wa.me dos anuncios, que abre o privado com a mensagem preenchida -
  // e como as pessoas comecam a falar com o bot sem salvar contato.
  BOT_NUMERO: z.string().regex(/^\d*$/, 'BOT_NUMERO: so digitos').default(''),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`Configuracao invalida no .env:\n${issues}`);
  process.exit(1);
}

export const config = parsed.data;

export const isGroupConfigured = config.GROUP_JID.length > 0;
