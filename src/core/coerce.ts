import { ScalarType } from '../ports/schema-provider';
import type { FieldType } from './entity-rules';
import { CrudError } from './crud-error';

const SKIP = Symbol('skip');

/**
 * Converte um valor vindo do corpo (JSON ou multipart) para o tipo da coluna.
 * Regras:
 * - string vazia, "null", "undefined" → `null` se a coluna aceita nulo; senão o
 *   campo é omitido (o banco usa o default ou acusa obrigatório).
 * - number: só aceita representação numérica — "abc" é 400 com o campo.
 * - boolean: true/false, "true"/"false", "1"/"0", "on".
 * - date: qualquer string que `Date` entenda.
 * - json: string JSON é parseada; inválida é 400.
 */
export function coerceValue(
  field: string,
  value: unknown,
  type: ScalarType,
  nullable: boolean,
  enumValues?: readonly string[],
): unknown {
  if (value === undefined) return SKIP;
  if (value === null || value === '' || value === 'null' || value === 'undefined') {
    return nullable ? null : SKIP;
  }
  switch (type) {
    case 'number': {
      if (typeof value === 'number') return value;
      const text = String(value).trim();
      if (!/^-?\d+(\.\d+)?$/.test(text)) {
        throw new CrudError('VALIDATION_FAILED', `Campo '${field}' deve ser numérico`, field);
      }
      return Number(text);
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const text = String(value).toLowerCase();
      if (['true', '1', 'on'].includes(text)) return true;
      if (['false', '0', 'off'].includes(text)) return false;
      throw new CrudError('VALIDATION_FAILED', `Campo '${field}' deve ser booleano`, field);
    }
    case 'date': {
      if (value instanceof Date) return value;
      const date = new Date(String(value));
      if (Number.isNaN(date.getTime())) {
        throw new CrudError('VALIDATION_FAILED', `Campo '${field}' deve ser uma data`, field);
      }
      return date;
    }
    case 'json': {
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value);
      } catch {
        throw new CrudError('VALIDATION_FAILED', `Campo '${field}' deve ser JSON válido`, field);
      }
    }
    default: {
      const text = typeof value === 'string' ? value : String(value);
      if (enumValues && !enumValues.includes(text)) {
        throw new CrudError('VALIDATION_FAILED', `Campo '${field}' aceita: ${enumValues.join(', ')}`, field);
      }
      return text;
    }
  }
}

/**
 * Lista escalar. Multipart manda "pix,boleto" (o front faz String(array));
 * JSON manda array. "" ou ausente-por-null vira lista vazia.
 */
function coerceList(field: string, value: unknown, meta: FieldType): unknown {
  if (value === undefined) return SKIP;
  let items: unknown[];
  if (Array.isArray(value)) items = value;
  else if (value === null || value === '' || value === 'null' || value === 'undefined') items = [];
  else if (typeof value === 'string' && value.trim().startsWith('[')) {
    try { items = JSON.parse(value); } catch { throw new CrudError('VALIDATION_FAILED', `Campo '${field}' deve ser uma lista`, field); }
  } else items = String(value).split(',').map((item) => item.trim()).filter(Boolean);
  return items.map((item) => {
    const coerced = coerceValue(field, item, meta.type, false, meta.enumValues);
    if (coerced === SKIP || coerced === null) {
      throw new CrudError('VALIDATION_FAILED', `Campo '${field}' tem item vazio`, field);
    }
    return coerced;
  });
}

export function coerceRow(
  row: Record<string, unknown>,
  types: Readonly<Record<string, FieldType>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(row)) {
    const meta = types[field];
    const coerced = !meta
      ? value
      : meta.isList
        ? coerceList(field, value, meta)
        : coerceValue(field, value, meta.type, meta.nullable, meta.enumValues);
    if (coerced !== SKIP) out[field] = coerced;
  }
  return out;
}

/** `:id` chega como string da URL: converte pelo tipo da pk; inválido = não existe. */
export function coerceId(id: unknown, type: 'string' | 'number'): unknown {
  if (type !== 'number') return id;
  if (typeof id === 'number') return id;
  const text = String(id ?? '').trim();
  if (!/^\d+$/.test(text)) throw new CrudError('NOT_FOUND', 'Registro não encontrado');
  return Number(text);
}
