# ADR-001 — Decisões fundacionais

Status: **aceito** · Data: 2026-08-30

## Contexto

Um `GenericController`/`GenericService` em uso em produção resolve CRUD declarativo bem
o suficiente para sustentar produtos reais, mas não é extraível: fica soldado ao
`PrismaService` local, à coluna de tenant, à tabela de log, ao serviço de upload, ao
`bcrypt` e ao `request.user` do Express. Empacotá-lo como está distribuiria o acoplamento
— e qualquer defeito junto.

Um manifesto declarativo por entidade (`defineEntity`) validado no boot é o desenho certo.
Mas acoplá-lo ao Prisma fecharia a porta para outros ORMs.

## Decisões

### D1 — O parser emite IR neutra, não `where` de ORM

Devolver `where` no formato Prisma seria uma
armadilha: o formato vazaria para o serviço, para os hooks e para as regras de entidade, e
"criar um adapter Sequelize" viraria reescrever tudo menos o parser.

O parser produz `FilterNode` (`src/query/filter-ir.ts`). O adapter compila IR → linguagem
do ORM. Nenhuma sintaxe de ORM atravessa uma porta.

**Consequência:** ~20% a mais de trabalho agora; um segundo adapter passa a ser trabalho
localizado em vez de reescrita.

### D2 — Desenhar todas as costuras, implementar um adapter

YAGNI vale para a implementação do Sequelize, não para a interface. `SchemaProvider` e
`Repository` nascem como portas; só o adapter Prisma é implementado. SQL cru fica como
possibilidade, não como meta de v1 — é outro patamar (dialeto, escape, joins).

### D3 — Um pacote, subpaths

`@adleron/crud-core`, `@adleron/crud-core/testing`, e futuramente `/prisma` e `/nestjs`.
Uma versão, um release, sem version skew entre pacotes irmãos. `@nestjs/*`, `@prisma/client`
e `vitest` são peerDependencies **opcionais**.

Dividir em pacotes separados só quando aparecer consumidor que precise de uma parte só.

### D4 — Acoplamento sai por porta, com default seguro

| Porta | Default se não injetada |
|---|---|
| `ScopeResolver` | ausente = single-tenant, sem filtro de escopo |
| `AuditSink` | `noopAuditSink` — quem não injeta, não audita |
| `PermissionChecker` | `denyAllPermissionChecker` — sem checker, rota com permissão não passa |
| `ActorProvider` | ausente = sem ator; quem exige ator lança, nunca inventa id 0 |
| `SchemaProvider` / `Repository` | obrigatórias, vêm do adapter |

O default do `PermissionChecker` é negar de propósito: autorização opt-in vira rota
aberta esquecida.

### D5 — Contrato de query: híbrido

Medido nos pontos de chamada reais de um front consumidor:

**Preservado** — `like-` `in-` `not-` `notlike-` `notin-` `gt-` `gte-` `lt-` `lte-` na
chave, `order-<campo>`, `limit`/`limit=all`, `page`, `show`, `active`, filtro aninhado e
`-aggregate`.

**Cortado** — `omitAttributes` (sem uso real, vira `maskedFields` declarado no servidor) e
`or` em JSON (vira `or.N.chave`). Nada de `eval` para interpretar query.

**Prefixos negativos** — `notin-` e `notlike-` são detectados com `startsWith()`, do mais
longo para o mais curto; com `includes()` eles cairiam no ramo positivo.

Custo de migração no front: **um arquivo**.

### D6 — Base64 não é criptografia

Codificar em base64 não protege nada e cria a impressão de que protege. Não existe
equivalente nesta lib; campo sensível se resolve com `maskedFields` (omissão) ou
criptografia de verdade na camada de persistência.

### D7 — Violação de filtro nunca é silenciosa

Campo fora da allowlist, operador inaplicável, valor malformado, grupo vazio → sempre
`QueryParseError` com `field` e `reason`. Nenhum caminho devolve filtro parcial. Descartar filtro inválido e responder com
resultado errado é pior que um erro.

### D8 — Semântica de data preservada de propósito

Data sem horário vira início do dia em `gt`/`gte` e fim do dia em `lt`/`lte`, no fuso local
do servidor, por compatibilidade com quem já consome. Mudar para UTC alteraria o
resultado de todo filtro de período em produção.

## Pendências conhecidas

- `defineEntity` deve rejeitar no boot campo declarado como `filterable` que também esteja
  na lista de chaves reservadas (`active`, `show`, `page`…). O conflito apareceu ao escrever
  os testes do parser e hoje resolve em favor da reserva, em silêncio.
- Adapter Prisma, camada NestJS, serviço de CRUD e auditoria transacional: próximas fatias.
