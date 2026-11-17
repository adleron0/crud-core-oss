/** Tipos escalares que o núcleo entende. O adapter traduz do ORM para estes. */
export type ScalarType = 'string' | 'number' | 'boolean' | 'date' | 'json';

export interface FieldMeta {
  name: string;
  type: ScalarType;
  nullable: boolean;
  isId: boolean;
  isUnique: boolean;
  /** Gerado pelo banco (default/autoincrement/updatedAt) — nunca gravável. */
  isGenerated: boolean;
  /** Lista escalar (`String[]`, `Enum[]`). */
  isList?: boolean;
  /** Valores aceitos quando o campo é enum. */
  enumValues?: readonly string[];
}

export interface RelationMeta {
  name: string;
  /** Nome do model relacionado, no vocabulário do SchemaProvider. */
  target: string;
  toMany: boolean;
}

export interface ModelMeta {
  name: string;
  fields: FieldMeta[];
  relations: RelationMeta[];
  /**
   * Campo de PK. `null` quando o model tem PK composta (tabela de junção, por
   * exemplo): o model continua no schema — outras entidades podem se relacionar
   * com ele — mas não pode ser exposto pelos generics, que precisam de `/:id`.
   */
  idField: string | null;
  /** Conjuntos de campos com constraint unique (inclui os de campo único). */
  uniques: string[][];
}

/**
 * Porta de METADADOS. É o que permite validar a declaração de uma entidade no
 * boot sem conhecer o ORM. O adapter Prisma a implementa lendo o DMMF; um
 * adapter Sequelize leria `Model.rawAttributes` + `associations`.
 */
export interface SchemaProvider {
  /** Retorna os metadados do model, ou null se ele não existe no schema. */
  model(name: string): ModelMeta | null;
}
