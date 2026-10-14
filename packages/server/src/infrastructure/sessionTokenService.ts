import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { UnauthenticatedError } from '../domain/errors.js';
import type { Clock } from '../application/ports.js';
import { toUserId, type UserId } from '../domain/ids.js';

export interface SessionTokenServiceOptions {
  readonly secret: string;
  readonly ttlMs: number;
  readonly clock: Clock;
}

export interface IssuedSession {
  readonly userId: UserId;
  readonly token: string;
  readonly expiresAt: Date;
}

interface TokenPayload {
  readonly sub: string;
  readonly exp: number;
}

const TOKEN_VERSION = 'v1';

/**
 * Stateless, signed session tokens.
 *
 * A flash-sale demo needs hundreds of distinct buyers, not a user database, so
 * a session is simply a signed assertion of an anonymous user id. The important
 * properties are the ones any real token scheme needs:
 *
 * - **Integrity**: HMAC-SHA256 over the payload. A client cannot change `sub`
 *   and become another user.
 * - **Expiry**: carried inside the signed payload, so it cannot be extended.
 * - **Constant-time comparison**: signature checks never leak timing.
 * - **No secrets in source**: the key comes from `SESSION_SECRET`.
 *
 * It intentionally handles no passwords and stores no credentials.
 */
export class SessionTokenService {
  constructor(private readonly options: SessionTokenServiceOptions) {}

  issue(): IssuedSession {
    const userId = toUserId(`user_${randomUUID()}`);
    const expiresAt = new Date(this.options.clock.now().getTime() + this.options.ttlMs);
    const payload: TokenPayload = { sub: userId, exp: expiresAt.getTime() };

    const encoded = base64UrlEncode(JSON.stringify(payload));
    return {
      userId,
      expiresAt,
      token: `${TOKEN_VERSION}.${encoded}.${this.sign(encoded)}`,
    };
  }

  /** Returns the authenticated user, or throws `UnauthenticatedError`. */
  verify(token: string): UserId {
    const parts = token.split('.');
    const [version, encoded, signature] = parts;

    if (parts.length !== 3 || version !== TOKEN_VERSION || !encoded || !signature) {
      throw new UnauthenticatedError('Malformed session token.');
    }
    if (!this.signatureMatches(encoded, signature)) {
      throw new UnauthenticatedError('Invalid session token.');
    }

    const payload = decodePayload(encoded);
    if (payload.exp <= this.options.clock.now().getTime()) {
      throw new UnauthenticatedError('Session expired. Start a new session.');
    }
    return toUserId(payload.sub);
  }

  private sign(encodedPayload: string): string {
    return createHmac('sha256', this.options.secret).update(encodedPayload).digest('base64url');
  }

  private signatureMatches(encodedPayload: string, candidate: string): boolean {
    const expected = Buffer.from(this.sign(encodedPayload), 'utf8');
    const actual = Buffer.from(candidate, 'utf8');
    // timingSafeEqual throws on length mismatch, which is itself a safe signal.
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}

const base64UrlEncode = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');

/**
 * Only ever called on a payload whose signature already verified, so the shape
 * is trusted — but still checked, because a parser that trusts its input is how
 * signature verification gets quietly bypassed later.
 */
const decodePayload = (encoded: string): TokenPayload => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'sub' in parsed &&
      'exp' in parsed &&
      typeof parsed.sub === 'string' &&
      typeof parsed.exp === 'number'
    ) {
      return { sub: parsed.sub, exp: parsed.exp };
    }
  } catch {
    throw new UnauthenticatedError('Invalid session token.');
  }
  throw new UnauthenticatedError('Invalid session token.');
};
