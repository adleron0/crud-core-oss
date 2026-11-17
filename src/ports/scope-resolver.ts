/**
 * Porta de ESCOPO (multi-tenant). É a porta que decide se isto é biblioteca ou
 * só um generic com outro nome: em vez de `companyId` literal no serviço,
 * quem consome declara o campo e como resolvê-lo.
 *
 * Não injetar = modo single-tenant: nenhum filtro de escopo é aplicado.
 */
export interface ScopeResolver<Ctx = unknown> {
  /** Nome da coluna de escopo no schema (ex.: 'companyId', 'tenantId'). */
  readonly field: string;
  /** Valor do escopo para a requisição atual. */
  resolve(context: Ctx): unknown;
}
