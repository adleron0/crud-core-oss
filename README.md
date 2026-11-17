# @adleron/crud-core

Núcleo de CRUD genérico declarativo — **agnóstico de ORM e de framework**.

Rotas opt-in por entidade, permissão obrigatória por operação, escopo multi-tenant,
auditoria com diff por coluna e parser de filtros com allowlist. Nasceu da extração de
um `GenericController`/`GenericService` usado em produção, sem o acoplamento.

> **Estado: `0.1.0` — fatia vertical completa.** Portas, IR de filtro e de agregação,
> parser, `defineEntity` com validação de boot, `CrudService`, adapter Prisma e camada
> NestJS. **281 testes.**
> Inclui as ops de self (`GET /self`, `PUT /self`).

## Princípios

1. **Declarar, não herdar.** A entidade declara o que expõe. Operação não declarada não
   vira rota — responde 404 porque não existe, não porque foi bloqueada.
2. **Permissão obrigatória.** Operação exposta sem permissão declarada aborta o boot.
3. **Violação nunca é silenciosa.** Filtro inválido é erro com campo apontado, jamais
   filtro descartado com resultado errado.
4. **Nenhuma sintaxe de ORM atravessa uma porta.** O parser emite IR neutra; o adapter
   traduz. É o que torna um segundo adapter viável.
5. **Acoplamento entra por injeção.** `companyId`, auditoria, permissão e ator são portas.

Ver [ADR-001](docs/adr/001-decisoes-fundacionais.md) para o porquê de cada decisão.

## Declaração de entidade

```ts
const customer = defineEntity(
  {
    entity: 'customer',
    model: 'Customer',
    expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'],
    permissions: {
      list: 'list_clientes',
      getById: 'list_clientes',
      create: 'create_clientes',
      update: 'update_clientes',
      archive: 'inactive_clientes',
      // restore NÃO é declarada: reusa sempre a do archive.
    },
    filterable: ['name', 'cnpj', 'createdAt', 'seller.name'],
    sortable: ['name', 'createdAt'],
    maskedFields: ['sellerConfig'],
    softDelete: { field: 'inactiveAt' },
  },
  { schema: prismaSchemaProvider(Prisma.dmmf), scopeField: 'companyId' },
);
```

Toda inconsistência é `BootError` — **a aplicação não sobe**:

- op exposta sem permissão declarada;
- `upsert` sem `upsertKey`, ou com chave sem constraint unique no schema;
- `restore` sem `archive`, ou com `permissions.restore` declarada à mão;
- campo filtrável/ordenável/mascarado que não existe no model;
- caminho de relação inexistente, ou com mais de um nível;
- campo filtrável que colide com chave reservada (seria ignorado em silêncio);
- campo mascarado declarado como filtrável ou ordenável (permitiria sondar o valor).

A allowlist de gravação é **derivada do schema**, não declarada: campos gerados, a coluna
de escopo, a PK (no update) e `status`/`statusId` (sem opt-in) ficam de fora. Campo que
existe mas é restrito na operação vira **400 com o campo apontado** — nunca descarte
silencioso, que é o jeito clássico de esconder um mass assignment.

## Contrato de filtro

Operador é **prefixo da chave**; o valor é livre.

```
GET /customer?like-name=ana&gte-createdAt=2026-01-01&lte-createdAt=2026-03-31
             &in-statusId=1,2&null-inactiveAt=true&order-name=asc&page=0&limit=20
```

| Prefixo | Operador | Aplicável a |
|---|---|---|
| *(nenhum)* | `eq` | qualquer |
| `not-` | `ne` | qualquer |
| `like-` | `contains` (case-insensitive) | texto |
| `notlike-` | `notContains` | texto |
| `in-` | `in` (CSV) | qualquer |
| `notin-` | `notIn` (CSV) | qualquer |
| `gt-` `gte-` `lt-` `lte-` | comparação | número, data |
| `null-` | `isNull` (`true`) / `ne null` (`false`) | campo nulável |

**Grupos OR:** `?or.0.like-name=x&or.0.isSeller=true&or.1.like-email=x` → união de dois
grupos AND. Um nível, sem aninhamento.

**Agregações:** `?-aggregate=status:count:sum:value` → `{ pending: { _count, _sum } }`.
Todo campo citado passa pela allowlist `aggregatable` — sem ela, agregação seria porta
para somar qualquer coluna. Sintaxe inválida é 400, nunca uma resposta sem o bloco.

**Relações:** só caminhos declarados em `filterable` (`'trainee.name'`). Relação to-many é
embrulhada em quantificador `some`. O cliente nunca escolhe o caminho.

Detecção de prefixo é sempre `startsWith`, do mais longo para o mais curto — `notin-` nunca
é confundido com `in-`.

## Adapters

Só o `compile-filter.ts` e o `repository.ts` do adapter conhecem a sintaxe do ORM. Um
adapter Sequelize substitui esses dois arquivos e nada mais do núcleo.

```ts
import { prismaRepository, prismaSchemaProvider } from '@adleron/crud-core/prisma';
```

`memoryRepository` (em `/testing`) é a **semântica de referência** da IR: um adapter real
deve produzir exatamente os mesmos resultados.

## Uso com NestJS

```ts
import { createCrudController, CrudErrorFilter } from '@adleron/crud-core/nestjs';

@Module({
  controllers: [createCrudController(customer)],
  providers: [
    { provide: CrudService, useFactory: () => new CrudService({
        repository: prismaRepository(prisma),
        scope: { field: 'companyId', resolve: (req) => req.user.companyId },
        actor: { resolve: (req) => req.user ? { type: 'user', id: req.user.sub } : null },
        audit: systemLogsSink,
        permissions: { has: (actor, p) => actor.permissions?.includes(p) ?? false },
      }) },
    { provide: APP_FILTER, useClass: CrudErrorFilter },
  ],
})
export class CustomerModule {}
```

Rotas registradas (só as do `expose`, preservando o contrato atual):

| Op | Rota |
|---|---|
| `list` | `GET /customer` |
| `getById` | `GET /customer/:id` |
| `create` | `POST /customer` |
| `update` | `PUT /customer/:id` |
| `archive` | `PATCH /customer/inactive/:id` |
| `restore` | `PATCH /customer/active/:id` |
| `upsert` | `POST /customer/upsert` |
| `getSelf` | `GET /customer/self` — id do ator, sem permissão |
| `updateSelf` | `PUT /customer/self` — allowlist estreitada por `selfRestricted` (obrigatório declarar) |

Op fora do `expose` **não vira método no controller** — o 404 vem de a rota não existir,
não de uma checagem que alguém pode esquecer de escrever.

## Suíte de conformidade

```ts
import { runRepositoryConformance } from '@adleron/crud-core/testing';

runRepositoryConformance({
  name: 'prisma',
  seed: async (model, rows) => { /* ... */ },
});
```

Um adapter que não passa nesta suíte não é um adapter.

## Instalação

Publicado no GitHub Packages. No projeto consumidor:

```
@adleron:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

## Desenvolvimento

```bash
pnpm install
pnpm test         # vitest
pnpm typecheck
pnpm build
```
