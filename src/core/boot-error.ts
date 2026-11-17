/**
 * Erro de DECLARAÇÃO, lançado no boot. Nunca é degradação silenciosa: uma
 * entidade mal declarada derruba a aplicação na subida, não em produção às
 * três da manhã.
 */
export class BootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootError';
  }
}
