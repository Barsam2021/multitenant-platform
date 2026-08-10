/**
 * P1-4 (Audit 0430f9c): Express 4 faengt Rejections aus async-Handlern nicht ab.
 * Wirft ein Handler (typisch: `await db.connect()` steht ausserhalb des try),
 * rejected die Handler-Promise unbehandelt. Node >= 15 behandelt
 * unhandledRejection standardmaessig wie ein throw -> Prozessende. `restart:
 * always` startet zwar neu, aber laufende Deployments sind weg, der komplette
 * In-Memory-State (activeDeployments, backupRunning, pollDomain-Loops) ist weg,
 * und ein halb fertiger Blue-Green-Swap bleibt halb fertig.
 *
 * Statt in zwoelf Route-Dateien jeden einzelnen Handler zu wrappen (und beim
 * naechsten neuen Handler wieder zu vergessen), wird hier der fertige
 * Router-Stack einmal nachtraeglich umgebogen. Ein Upgrade auf express@5 wuerde
 * das ueberfluessig machen — bis dahin ist das die Variante, die keine
 * bestehende Zeile anfassen muss.
 */
type AnyFn = (...args: any[]) => any;

function wrapHandler(fn: AnyFn): AnyFn {
  // 4 Parameter = Error-Middleware, die darf nicht umgebogen werden.
  if (fn.length >= 4) return fn;
  const wrapped = function (this: any, req: any, res: any, next: any) {
    try {
      const out = fn.call(this, req, res, next);
      if (out && typeof out.then === 'function') {
        return Promise.resolve(out).catch(next);
      }
      return out;
    } catch (err) {
      return next(err);
    }
  };
  Object.defineProperty(wrapped, 'length', { value: fn.length });
  return wrapped;
}

/** Biegt alle bereits registrierten Routen-Handler eines Routers/einer App um. */
export function wrapRouterAsync(routerOrApp: any): void {
  const stack = routerOrApp?.stack || routerOrApp?._router?.stack;
  if (!Array.isArray(stack)) return;
  for (const layer of stack) {
    if (!layer?.route?.stack) continue;
    for (const routeLayer of layer.route.stack) {
      if (typeof routeLayer.handle === 'function' && !routeLayer.handle.__asyncWrapped) {
        const wrapped = wrapHandler(routeLayer.handle);
        (wrapped as any).__asyncWrapped = true;
        routeLayer.handle = wrapped;
      }
    }
  }
}
