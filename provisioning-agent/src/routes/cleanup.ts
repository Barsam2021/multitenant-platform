import { Router } from 'express';
import { runCleanup } from '../lib/cleanup';

export const cleanupRouter = Router();

// POST /cleanup/run — manueller Trigger (die eigentliche Ausfuehrung laeuft
// sonst taeglich per Timer, siehe index.ts). Antwortet erst nach Abschluss,
// nicht fire-and-forget wie ein Deploy - ein Aufraeum-Lauf dauert typischerweise
// Sekunden, nicht Minuten (kein Grund fuer Polling-Infrastruktur dafuer).
cleanupRouter.post('/cleanup/run', async (_req, res) => {
  try {
    const result = await runCleanup();
    res.json({ status: 'ok', ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
