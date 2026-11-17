import { FieldMeta, ModelMeta, RelationMeta, ScalarType, SchemaProvider } from '../../ports/schema-provider';
import { Dmmf, DmmfEnum, DmmfField, DmmfModel } from './dmmf.types';

const NUMERIC = new Set(['Int', 'BigInt', 'Float', 'Decimal']);

function scalarType(field: DmmfField): ScalarType {
  if (field.kind === 'enum') return 'string';
  if (NUMERIC.has(field.type)) return 'number';
  if (field.type === 'Boolean') return 'boolean';
  if (field.type === 'DateTime') return 'date';
  if (field.type === 'Json') return 'json';
  return 'string';
}

/**
 * Nunca gravável pela API: `@updatedAt`, `createdAt` com default, e PK com
 * default (autoincrement/uuid/cuid). Campo com default que NÃO é PK continua
 * gravável — `active @default(true)` precisa poder vir no create.
 */
function isGenerated(field: DmmfField): boolean {
  if (field.isUpdatedAt) return true;
  if (field.name === 'createdAt' && field.hasDefaultValue) return true;
  return Boolean(field.isId && field.hasDefaultValue);
}

function toModelMeta(model: DmmfModel, enums: Map<string, string[]>): ModelMeta {
  // Listas escalares (`paymentMethods paymentMethods[]`) entram: ignorá-las
  // fazia o valor enviado pelo cliente ser descartado em silêncio.
  const fields: FieldMeta[] = model.fields
    .filter((field) => field.kind !== 'object')
    .map((field) => ({
      name: field.name,
      type: scalarType(field),
      nullable: !field.isRequired || field.isList,
      isId: field.isId,
      isUnique: field.isUnique,
      isGenerated: isGenerated(field),
      ...(field.isList ? { isList: true } : {}),
      ...(field.kind === 'enum' && enums.has(field.type) ? { enumValues: enums.get(field.type)! } : {}),
    }));

  const relations: RelationMeta[] = model.fields
    .filter((field) => field.kind === 'object' && field.relationName)
    .map((field) => ({ name: field.name, target: field.type, toMany: field.isList }));

  // PK composta (tabela de junção) não estoura aqui: o model segue no schema
  // e só é recusado se alguém tentar declará-lo como entidade (BootError com
  // mensagem de declaração, não erro de infraestrutura na subida).
  const single = model.primaryKey?.fields.length === 1 ? model.primaryKey.fields[0] : undefined;
  const idField = fields.find((field) => field.isId)?.name ?? single ?? null;

  const uniques = [
    ...fields.filter((field) => field.isUnique || field.isId).map((field) => [field.name]),
    ...(model.uniqueFields ?? []),
  ];

  return { name: model.name, fields, relations, idField, uniques };
}

/** SchemaProvider lendo o DMMF do client gerado: `PrismaSchemaProvider(Prisma.dmmf)`. */
export function prismaSchemaProvider(dmmf: Dmmf): SchemaProvider {
  const enums = new Map<string, string[]>(
    (dmmf.datamodel.enums ?? []).map((e: DmmfEnum) => [e.name, e.values.map((v) => v.name)]),
  );
  const cache = new Map<string, ModelMeta>();
  for (const model of dmmf.datamodel.models) {
    cache.set(model.name, toModelMeta(model, enums));
  }
  return { model: (name) => cache.get(name) ?? null };
}
