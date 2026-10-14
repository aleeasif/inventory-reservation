import type { CreateSessionResponse } from '@inventory/shared';
import { Router } from 'express';
import type { SessionTokenService } from '../../infrastructure/sessionTokenService.js';

/**
 * Issues an anonymous, signed session so a caller has a stable identity.
 *
 * No credentials are involved by design: the system needs to know *which* buyer
 * is acting, not who they are in real life, and a challenge project has no
 * business storing passwords.
 */
export const createSessionRoutes = (tokens: SessionTokenService): Router => {
  const router = Router();

  router.post('/', (_req, res) => {
    const session = tokens.issue();
    const body: CreateSessionResponse = {
      userId: session.userId,
      token: session.token,
      expiresAt: session.expiresAt.toISOString(),
    };
    res.status(201).json(body);
  });

  return router;
};
