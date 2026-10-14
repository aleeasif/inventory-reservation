import type { HealthResponse } from '@inventory/shared';
import { Router } from 'express';

/** Liveness probe. Deliberately exposes no internal state. */
export const createHealthRoutes = (version: string): Router => {
  const router = Router();

  router.get('/', (_req, res) => {
    const body: HealthResponse = {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      version,
    };
    res.status(200).json(body);
  });

  return router;
};
