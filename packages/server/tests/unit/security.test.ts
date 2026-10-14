import { describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfig } from '../../src/config/env.js';
import { UnauthenticatedError } from '../../src/domain/errors.js';
import { InMemoryIdempotencyStore } from '../../src/infrastructure/inMemoryIdempotencyStore.js';
import { SessionTokenService } from '../../src/infrastructure/sessionTokenService.js';
import { FakeClock } from '../../src/infrastructure/systemClock.js';

const SECRET = 'a-secret-that-is-at-least-32-characters';

const buildTokens = (clock = new FakeClock(), secret = SECRET): SessionTokenService =>
  new SessionTokenService({ secret, ttlMs: 60_000, clock });

describe('SessionTokenService', () => {
  it('round-trips the user it issued', () => {
    const tokens = buildTokens();
    const session = tokens.issue();

    expect(tokens.verify(session.token)).toBe(session.userId);
  });

  it('issues a distinct identity per session', () => {
    const tokens = buildTokens();
    expect(tokens.issue().userId).not.toBe(tokens.issue().userId);
  });

  it('rejects a token whose payload was edited', () => {
    const tokens = buildTokens();
    const [version, , signature] = tokens.issue().token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: 'user_admin', exp: Date.now() + 60_000 }),
      'utf8',
    ).toString('base64url');

    expect(() => tokens.verify(`${version ?? ''}.${forgedPayload}.${signature ?? ''}`)).toThrow(
      UnauthenticatedError,
    );
  });

  it('rejects a token signed with a different secret', () => {
    const foreign = buildTokens(new FakeClock(), 'a-different-secret-of-sufficient-length');

    expect(() => buildTokens().verify(foreign.issue().token)).toThrow(UnauthenticatedError);
  });

  it('rejects a malformed token without leaking why', () => {
    const tokens = buildTokens();

    for (const bad of ['', 'nonsense', 'v1.only-two', 'v2.abc.def', '..']) {
      expect(() => tokens.verify(bad)).toThrow(UnauthenticatedError);
    }
  });

  it('rejects an expired token even though the signature is valid', () => {
    const clock = new FakeClock();
    const tokens = buildTokens(clock);
    const session = tokens.issue();

    clock.advanceBy(60_001);
    expect(() => tokens.verify(session.token)).toThrow(/expired/iu);
  });
});

describe('InMemoryIdempotencyStore', () => {
  it('forgets an entry once its TTL passes', async () => {
    const clock = new FakeClock();
    const store = new InMemoryIdempotencyStore<string>({ clock, ttlMs: 1_000, maxEntries: 10 });

    await store.set('k', { fingerprint: 'f', value: 'v' });
    clock.advanceBy(1_001);

    expect(await store.get('k')).toBeUndefined();
  });

  it('evicts the oldest entry instead of growing without bound', async () => {
    const store = new InMemoryIdempotencyStore<string>({
      clock: new FakeClock(),
      ttlMs: 60_000,
      maxEntries: 3,
    });

    for (const key of ['a', 'b', 'c', 'd']) {
      await store.set(key, { fingerprint: 'f', value: key });
    }

    expect(store.size).toBe(3);
    expect(await store.get('a')).toBeUndefined();
    expect(await store.get('d')).toMatchObject({ value: 'd' });
  });
});

describe('Configuration', () => {
  const baseEnv = { SESSION_SECRET: SECRET };

  it('applies safe defaults', () => {
    const config = loadConfig(baseEnv);

    expect(config).toMatchObject({
      NODE_ENV: 'development',
      PORT: 4000,
      TRUST_PROXY: false,
      BODY_LIMIT: '4kb',
    });
    expect(config.corsOrigins).toEqual(['http://localhost:5173']);
    expect(config.RESERVATION_HOLD_MS).toBe(120_000);
  });

  it('refuses to start in production without a session secret', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(ConfigurationError);
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/SESSION_SECRET/u);
  });

  it('refuses a session secret that is too short to be a real key', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'short' })).toThrow(
      ConfigurationError,
    );
  });

  it('generates an ephemeral secret outside production rather than shipping a default', () => {
    const first = loadConfig({});
    const second = loadConfig({});

    expect(first.sessionSecret).not.toBe(second.sessionSecret);
    expect(first.sessionSecret.length).toBeGreaterThanOrEqual(32);
  });

  it('names every offending variable when configuration is wrong', () => {
    expect(() => loadConfig({ ...baseEnv, PORT: '0', LOG_LEVEL: 'loud' })).toThrow(/PORT/u);
    expect(() => loadConfig({ ...baseEnv, PORT: '0', LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/u);
  });

  it('parses a multi-origin CORS allowlist', () => {
    const config = loadConfig({
      ...baseEnv,
      CORS_ALLOWED_ORIGINS: 'https://shop.example , https://admin.example',
    });

    expect(config.corsOrigins).toEqual(['https://shop.example', 'https://admin.example']);
  });
});
