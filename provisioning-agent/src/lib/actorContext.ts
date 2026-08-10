import { AsyncLocalStorage } from 'async_hooks';

// P3-5: 'actor' stand im Audit-Log bisher hart auf 'admin', an jeder einzelnen
// der ~20 logAudit()-Aufrufstellen haette das Herumreichen des echten Actors
// durch jede Funktionssignatur bedeutet. AsyncLocalStorage macht das pro-Request
// implizit verfuegbar - eine Middleware setzt es einmal, logAudit() liest es,
// ohne dass ein bestehender Aufruf angefasst werden muss.
export interface ActorInfo {
  actor: string;
  ip: string | null;
  userAgent: string | null;
}

export const actorStorage = new AsyncLocalStorage<ActorInfo>();

export function currentActor(): ActorInfo {
  return actorStorage.getStore() || { actor: 'admin', ip: null, userAgent: null };
}
