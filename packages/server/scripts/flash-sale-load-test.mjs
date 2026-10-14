#!/usr/bin/env node
/**
 * Fires N simultaneous "Buy" clicks at a *running* server and reports what came
 * back. This is the manual counterpart to tests/concurrency: same scenario,
 * real sockets, real process boundaries.
 *
 *   npm run dev:server          # terminal 1
 *   npm run test:load           # terminal 2
 *
 * Options (environment variables):
 *   BASE_URL   default http://localhost:4000
 *   PRODUCT_ID default flash-sale-single
 *   BUYERS     default 500
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4000';
const PRODUCT_ID = process.env.PRODUCT_ID ?? 'flash-sale-single';
const BUYERS = Number.parseInt(process.env.BUYERS ?? '500', 10);
const API = `${BASE_URL}/api/v1`;

const openSession = async () => {
  const response = await fetch(`${API}/sessions`, { method: 'POST' });
  if (response.status === 429) {
    throw new Error(
      'Rate limited while opening sessions. The server protects itself by default; ' +
        'start it in demo mode instead:  npm run dev:server:demo',
    );
  }
  if (!response.ok) {
    throw new Error(`Could not open a session (HTTP ${response.status}). Is the server running?`);
  }
  const { token } = await response.json();
  return token;
};

const attemptReservation = async (token) => {
  const response = await fetch(`${API}/reservations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ productId: PRODUCT_ID, quantity: 1 }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, code: body?.error?.code ?? 'OK' };
};

const main = async () => {
  console.log(`Opening ${BUYERS} sessions against ${BASE_URL} ...`);
  const tokens = await Promise.all(Array.from({ length: BUYERS }, openSession));

  const before = await (await fetch(`${API}/products/${PRODUCT_ID}`)).json();
  console.log(
    `Stock before: ${before.product.available} available of ${before.product.totalStock}`,
  );

  console.log(`Firing ${BUYERS} simultaneous reservations ...`);
  const startedAt = performance.now();
  const outcomes = await Promise.all(tokens.map(attemptReservation));
  const elapsedMs = performance.now() - startedAt;

  const tally = new Map();
  for (const { status, code } of outcomes) {
    const key = `${status} ${code}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }

  const after = await (await fetch(`${API}/products/${PRODUCT_ID}`)).json();
  const sold = after.product.confirmedSales + after.product.activeReservations;

  console.log('\nOutcomes');
  for (const [key, count] of [...tally].sort()) {
    console.log(`  ${key.padEnd(28)} ${count}`);
  }

  console.log(`\nElapsed            ${elapsedMs.toFixed(0)} ms`);
  console.log(`Units accounted    ${sold} (never more than ${after.product.totalStock})`);
  console.log(
    sold <= after.product.totalStock ? '\nPASS — no overselling.' : '\nFAIL — the system oversold.',
  );
  process.exitCode = sold <= after.product.totalStock ? 0 : 1;
};

main().catch((error) => {
  console.error(`\nLoad test failed: ${error.message}`);
  process.exitCode = 1;
});
