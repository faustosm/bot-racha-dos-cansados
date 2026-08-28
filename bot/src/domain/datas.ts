// Funcoes puras de data. Separadas de partida.ts de proposito: aquele modulo
// importa config e banco, e nada disso e necessario para calcular um sabado.
// Assim os testes rodam sem .env e sem Postgres.
//
// Tudo opera em horario LOCAL do processo. Os containers usam
// TZ=America/Sao_Paulo (docker-compose.yml), entao "12:00" e meio-dia daqui.

const SABADO = 6;

export function isoDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Proximo sabado a partir de `agora`. Se hoje ja e sabado, devolve hoje. */
export function proximoSabado(agora: Date): string {
  const d = new Date(agora);
  d.setDate(d.getDate() + ((SABADO - d.getDay() + 7) % 7));
  return isoDate(d);
}

function emDia(dataJogo: string, deltaDias: number, hora: number): Date {
  const [ano, mes, dia] = dataJogo.split('-').map(Number);
  return new Date(ano ?? 1970, (mes ?? 1) - 1, (dia ?? 1) + deltaDias, hora);
}

/** Hora em que a lista fecha no sabado. Duas horas antes da bola rolar. */
export const HORA_FECHA = 7;

/** Hora do encerramento (avaliacao pos-jogo), depois do jogo acabar. */
export const HORA_ENCERRAMENTO = 12;

/** Hora em que a lista abre pros fixos (quarta, 3 dias antes do jogo). */
export const HORA_ABRE_FIXOS = 12;

const QUARTA = 3;

/**
 * As quatro janelas de uma partida, derivadas da data do jogo:
 * quarta 12:00 (fixos), quinta 12:00 (convidados), sabado 07:00 (fecha,
 * 2h antes do jogo), sabado 12:00 (encerra, depois do jogo).
 *
 * Fecha antes do jogo de proposito: quem organiza precisa da lista definitiva
 * com antecedencia para completar time ou cancelar, nao no minuto do apito.
 */
export function janelas(dataJogo: string): {
  abreFixos: Date;
  abreConvidados: Date;
  fechaEm: Date;
  encerraEm: Date;
} {
  return {
    abreFixos: emDia(dataJogo, -3, HORA_ABRE_FIXOS),
    abreConvidados: emDia(dataJogo, -2, 12),
    fechaEm: emDia(dataJogo, 0, HORA_FECHA),
    encerraEm: emDia(dataJogo, 0, HORA_ENCERRAMENTO),
  };
}

/**
 * Ate quando a avaliacao pos-jogo aceita nota: a mesma quarta 12:00 em que a
 * PROXIMA partida abre pros fixos (4 dias depois do sabado do jogo avaliado).
 * Escolhido de proposito para casar com o fixa/desfixa manual da enquete no
 * grupo - quando a nova enquete de confirmacao sobe, a de nota ja fechou.
 */
export function janelaAvaliacao(dataJogo: string): Date {
  return emDia(dataJogo, 4, HORA_ENCERRAMENTO);
}

export type StatusAbertura =
  | { readonly tipo: 'abre_em'; readonly data: Date }
  | { readonly tipo: 'a_qualquer_momento' };

/**
 * Quando abre a proxima janela pros fixos, a partir de `agora` - usada so
 * quando NAO ha partida "atual" no banco (fora da janela do racha corrente).
 *
 * Calcula a proxima quarta DIRETO do dia da semana de `agora`, sem passar por
 * `proximoSabado`: aquela funcao devolve HOJE quando hoje ja e sabado, e
 * compor `janelas(proximoSabado(agora)).abreFixos` em cima disso erraria bem
 * no caso mais comum (sabado depois das 7h, sem partida "atual" -> cairia
 * numa quarta que ja passou).
 */
export function proximaAberturaFixos(agora: Date): StatusAbertura {
  const d = new Date(agora);
  const diasAteQuarta = (QUARTA - d.getDay() + 7) % 7;
  if (diasAteQuarta === 0 && d.getHours() >= HORA_ABRE_FIXOS) {
    // Ja e quarta e ja passou do meio-dia: a criacao da partida
    // (garantirPartida, via CRON_ABRE_FIXOS) deve estar rolando agora.
    return { tipo: 'a_qualquer_momento' };
  }
  d.setDate(d.getDate() + diasAteQuarta);
  d.setHours(HORA_ABRE_FIXOS, 0, 0, 0);
  return { tipo: 'abre_em', data: d };
}
