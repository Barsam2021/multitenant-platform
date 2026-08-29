import { Router } from 'express';
import { runCleanup } from '../lib/cleanup';

export const cleanupRouter = Router();

// POST /cleanup/run — manueller Trigger (die eigentliche Ausfuehrung laeuft
// sonst taeglich per Timer, siehe index.ts). Antwortet erst nach Abschluss,
// nicht fire-and-forget wie ein Deploy - ein Aufraeum-Lauf dauert typischerweise
// Sekunden, nicht Minuten (kein Grund fuer Polling-Infrastruktur dafuer).
//
// Ausnahme seit pruneBuildCache(): der ERSTE Lauf gegen einen nie geprunten
// BuildKit-Cache kann Minuten dauern (Messung 2026-08-27: 57,7 GB gewachsen).
// Der Prune hat deshalb ein eigenes Timeout von 10 Minuten; laeuft er in einen
// HTTP-Timeout des Aufrufers, arbeitet er serverseitig trotzdem zu Ende und das
// Ergebnis steht im Audit-Log unter cleanup.run. Ab dem zweiten Lauf greift
// wieder die Sekunden-Annahme.
cleanupRouter.post('/cleanup/run', async (_req, res) => {
  try {
    const result = await runCleanup();
    res.json({ status: 'ok', ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
