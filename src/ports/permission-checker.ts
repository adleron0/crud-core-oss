import { Actor } from './actor-provider';

/**
 * Porta de AUTORIZAÇÃO. O núcleo só sabe o NOME da permissão que a entidade
 * declarou; quem responde é o consumidor (array no JWT, resolver com cache,
 * o que for).
 */
export interface PermissionChecker {
  has(actor: Actor, permission: string): boolean | Promise<boolean>;
}

/** Nega tudo. É o default deliberado: sem checker, rota com permissão não passa. */
export const denyAllPermissionChecker: PermissionChecker = {
  has: () => false,
};
