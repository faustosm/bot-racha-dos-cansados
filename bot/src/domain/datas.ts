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
    abreFixos: emDia(dataJogo, -3, 12),
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
