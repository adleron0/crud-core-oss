import { FieldMeta, ModelMeta, RelationMeta, ScalarType, SchemaProvider } from '../ports/schema-provider';

export interface FakeFieldSpec {
  type?: ScalarType;
  nullable?: boolean;
  isId?: boolean;
  isUnique?: boolean;
  isGenerated?: boolean;
  isList?: boolean;
  enumValues?: string[];
}

export interface FakeModelSpec {
  fields: Record<string, FakeFieldSpec>;
  relations?: Record<string, { target: string; toMany?: boolean }>;
  /** `null` declara pk composta explicitamente (tabela de junção). */
  idField?: string | null;
  uniques?: string[][];
}

/**
 * SchemaProvider em memória. Serve aos testes deste pacote e ao consumidor que
 * queira validar as próprias `EntityRules` sem subir banco nem gerar client.
 */
export function fakeSchema(models: Record<string, FakeModelSpec>): SchemaProvider {
  const compiled = new Map<string, ModelMeta>();

  for (const [name, spec] of Object.entries(models)) {
    const fields: FieldMeta[] = Object.entries(spec.fields).map(([fieldName, field]) => ({
      name: fieldName,
      type: field.type ?? 'string',
      nullable: field.nullable ?? false,
      isId: field.isId ?? false,
      isUnique: field.isUnique ?? false,
      isGenerated: field.isGenerated ?? false,
      ...(field.isList ? { isList: true } : {}),
      ...(field.enumValues ? { enumValues: field.enumValues } : {}),
    }));
    const relations: RelationMeta[] = Object.entries(spec.relations ?? {}).map(
      ([relationName, relation]) => ({
        name: relationName,
        target: relation.target,
        toMany: relation.toMany ?? false,
      }),
    );
    // `??` não serve: `null` é declaração explícita de pk composta e precisa
    // sobreviver ao default.
    const idField =
      spec.idField !== undefined
        ? spec.idField
        : (fields.find((field) => field.isId)?.name ?? fields[0]?.name ?? null);

    compiled.set(name, {
      name,
      fields,
      relations,
      idField,
      uniques: spec.uniques ?? fields.filter((f) => f.isUnique).map((f) => [f.name]),
    });
  }

  return { model: (name) => compiled.get(name) ?? null };
}
