export type ActorType = 'user' | 'system' | 'service' | 'gateway' | 'automation';

export interface Actor {
  type: ActorType;
  id: string;
  label?: string;
  scopeId?: unknown;
  requestId?: string;
  ip?: string;
  onBehalfOf?: string;
  /** Permissões já resolvidas, quando o consumidor as tem em mãos. */
  permissions?: readonly string[];
}

/**
 * Porta de ATOR. Ator passado por parâmetro posicional com
 * default vira "evento do sistema" silencioso. Aqui a ausência é explícita —
 * quem exige ator recebe `null` e decide lançar, nunca inventa um id 0.
 */
export interface ActorProvider<Ctx = unknown> {
  resolve(context: Ctx): Actor | null;
}
