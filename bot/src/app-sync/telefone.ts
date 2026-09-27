/**
 * Casa o telefone digitado no app (texto livre, ex: "+5534999999999") com o
 * telefone do bot (JID cru do WhatsApp, ex: "553499999999@s.whatsapp.net").
 *
 * Nao da pra comparar string inteira: os dois lados variam em DDI (55), no
 * "9" opcional do celular e em separadores/sufixo. Em vez de tratar cada
 * variacao, extrai so digitos e compara os ULTIMOS 8 - o numero de assinante
 * brasileiro e fixo em 8 digitos, entao isso absorve DDI, DDD e o 9 de uma
 * vez so. Risco aceito: colisao de ultimos-8-digitos entre DDDs diferentes e
 * teoricamente possivel, mas desprezivel num grupo de racha de uma regiao so.
 */

const MIN_DIGITOS = 8;

/** So digitos, ultimos 8. `null` se nao der pra formar um numero valido. */
export function normalizarTelefone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digitos = raw.replace(/\D+/g, '');
  if (digitos.length < MIN_DIGITOS) return null;
  return digitos.slice(-MIN_DIGITOS);
}

/** Mesmo numero de assinante, ignorando DDI/DDD/formatacao? */
export function telefonesEquivalentes(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = normalizarTelefone(a);
  const nb = normalizarTelefone(b);
  return na !== null && na === nb;
}
