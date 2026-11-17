import { Actor } from './actor-provider';

export interface AuditEntry {
  actor: Actor;
  action: string;
  entity: string;
  entityId: string;
  /** Uma entrada por coluna alterada (diff), como num `audit_log`. */
  column: string | null;
  oldValue: string | null;
  newValue: string | null;
  scopeId?: unknown;
  requestId?: string;
  ip?: string;
  occurredAt: Date;
}

/**
 * Porta de AUDITORIA. O default é no-op: quem não injeta, não audita. Quem
 * injeta recebe as entradas DENTRO da transação da escrita — auditoria que
 * commita junto com a mutação, não fire-and-forget.
 */
export interface AuditSink {
  write(entries: AuditEntry[]): Promise<void>;
}

export const noopAuditSink: AuditSink = {
  async write() {
    /* intencionalmente vazio */
  },
};
