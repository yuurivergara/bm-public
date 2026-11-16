/**
 * Validação de CNPJ numérico e alfanumérico.
 *
 * A partir de julho/2026 a Receita Federal passou a emitir CNPJs alfanuméricos: as 12 primeiras
 * posições aceitam 0–9 e A–Z; os 2 dígitos verificadores continuam numéricos. O cálculo usa o
 * valor ASCII do caractere menos 48 (para dígitos equivale ao próprio número).
 */
export function normalizeCnpj(input: string): string {
  return input.toUpperCase().replace(/[.\-/\s]/g, '');
}

export function isValidCnpj(input: string): boolean {
  const cnpj = normalizeCnpj(input);
  if (!/^[0-9A-Z]{12}\d{2}$/.test(cnpj)) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false;

  const values = [...cnpj].map((c) => c.charCodeAt(0) - 48);
  const dv1 = checkDigit(values.slice(0, 12));
  const dv2 = checkDigit([...values.slice(0, 12), dv1]);
  return values[12] === dv1 && values[13] === dv2;
}

function checkDigit(values: number[]): number {
  let weight = values.length - 7;
  let sum = 0;
  for (const value of values) {
    sum += value * weight;
    weight = weight === 2 ? 9 : weight - 1;
  }
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}
