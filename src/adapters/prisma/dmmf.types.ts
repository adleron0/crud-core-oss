/**
 * Shape estrutural do DMMF do Prisma. Declarado localmente de propósito: o
 * pacote precisa instalar e compilar sem `@prisma/client` presente (peer
 * dependency opcional).
 */
export interface DmmfField {
  name: string;
  kind: 'scalar' | 'object' | 'enum' | 'unsupported';
  type: string;
  isRequired: boolean;
  isList: boolean;
  isId: boolean;
  isUnique: boolean;
  isUpdatedAt?: boolean;
  hasDefaultValue?: boolean;
  relationName?: string;
}

export interface DmmfModel {
  name: string;
  fields: DmmfField[];
  primaryKey?: { fields: string[] } | null;
  uniqueFields?: string[][];
}

export interface DmmfEnum {
  name: string;
  values: Array<{ name: string }>;
}

export interface Dmmf {
  datamodel: { models: DmmfModel[]; enums?: DmmfEnum[] };
}
