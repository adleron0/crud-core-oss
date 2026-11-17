import { Repository, Row } from '../ports/repository';
import { FilterNode } from '../query/filter-ir';
import { WriteOp } from './entity-rules';

export interface PreWriteContext<Ctx = unknown> {
  /** O contexto da requisição (no NestJS, o request) — para upload, ator etc. */
  context: Ctx;
  /** Dependências injetadas pelo consumidor no CrudService (`hookDeps`). */
  deps: Record<string, unknown>;
  op: WriteOp;
  data: Row;
  /** Registro atual — presente em update/archive/restore. */
  existing?: Row;
  scopeId?: unknown;
  /** Repositório DENTRO da transação: leituras de guarda e escritas extras. */
  repository: Repository;
}

export interface PostWriteContext<Ctx = unknown> {
  context: Ctx;
  deps: Record<string, unknown>;
  op: WriteOp;
  result: Row;
  existing?: Row;
  scopeId?: unknown;
  /** Ainda dentro da transação: falhar aqui desfaz a mutação. */
  repository: Repository;
}

export interface PreListContext<Ctx = unknown> {
  context: Ctx;
  deps: Record<string, unknown>;
  scopeId?: unknown;
  repository: Repository;
}

export interface EntityHooks<Ctx = unknown> {
  /** Pode devolver um novo `data`, que substitui o do comando. */
  preWrite?(context: PreWriteContext<Ctx>): Promise<Row | void> | Row | void;
  postWrite?(context: PostWriteContext<Ctx>): Promise<void> | void;
  /** Pode devolver um filtro extra, combinado em AND com o da query. */
  preList?(context: PreListContext<Ctx>): Promise<FilterNode | void> | FilterNode | void;
}

/** Encadeia hooks: preWrite/preList acumulam; postWrite roda todos. */
export function composeHooks<Ctx = unknown>(...hooks: Array<EntityHooks<Ctx> | undefined>): EntityHooks<Ctx> {
  const list = hooks.filter((hook): hook is EntityHooks<Ctx> => Boolean(hook));
  return {
    preWrite: async (context) => {
      let data = context.data;
      for (const hook of list) {
        const patched = await hook.preWrite?.({ ...context, data });
        if (patched) data = patched;
      }
      return data;
    },
    postWrite: async (context) => {
      for (const hook of list) await hook.postWrite?.(context);
    },
    preList: async (context) => {
      const nodes: FilterNode[] = [];
      for (const hook of list) {
        const node = await hook.preList?.(context);
        if (node) nodes.push(node);
      }
      if (nodes.length === 0) return undefined;
      return nodes.length === 1 ? nodes[0] : { kind: 'and', nodes };
    },
  };
}
