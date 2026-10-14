# Inventory Reservation System

**Preventing overselling in a high-concurrency flash sale.**

One unit of stock. Five hundred people click _Buy_ in the same millisecond. Exactly one of
them gets it, the other 499 are told the truth immediately, and the unit returns to the shelf
if the winner walks away.

That guarantee — and the evidence for it — is what this repository is.

---

## Contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [The concurrency story](#the-concurrency-story)
- [Architecture](#architecture)
- [API reference](#api-reference)
- [Testing](#testing)
- [Security](#security)
- [Configuration](#configuration)
- [Design decisions and trade-offs](#design-decisions-and-trade-offs)
- [What production would add](#what-production-would-add)
- [AI disclosure](#ai-disclosure)

---

## What it does

The challenge defines three levels. All three are implemented, plus a React storefront that
makes the behaviour visible.

| Level | Requirement                                                                   | Where it lives                                                                                                                                       |
| ----- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | In-memory inventory, reserve operation, reject when stock is unavailable      | [domain/inventory.ts](packages/server/src/domain/inventory.ts)                                                                                       |
| 2     | ACTIVE → CONFIRMED / CANCELLED / EXPIRED, 2-minute hold, automatic release    | [domain/reservation.ts](packages/server/src/domain/reservation.ts), [application/expirySweeper.ts](packages/server/src/application/expirySweeper.ts) |
| 3     | No race conditions: 1 success and 499 failures from 500 simultaneous requests | [infrastructure/keyedMutex.ts](packages/server/src/infrastructure/keyedMutex.ts), [tests/concurrency/](packages/server/tests/concurrency)            |

**The business rule, exactly as specified:**

```
available = totalStock − confirmedSales − activeReservations
```

- A reservation for more than `available` fails. It is never silently reduced.
- A confirmed purchase is terminal and can never be reversed.
- Only one user can hold the last item.
- An expired reservation releases its stock automatically.

---

## Quick start

Requires **Node 20.11+** (`.nvmrc` pins 22).

```bash
nvm use && npm install && npm run build
```

Run the API and the storefront together:

```bash
npm run dev
```

- API — [http://localhost:4000/api/v1/health](http://localhost:4000/api/v1/health)
- Storefront — [http://localhost:5173](http://localhost:5173)

Run the full verification gate (format, lint, types, tests):

```bash
npm run verify
```

### See the flash sale for yourself

The storefront has a **Concurrency lab**: pick a product, pick 500 simultaneous buyers, press
run. Each simulated buyer opens its own signed session, so nothing but the server's locking
decides the winner.

Large simulations need the rate limiter out of the way, so start the API in demo mode:

```bash
npm run dev:server:demo
```

The same scenario from the command line, against a running server:

```bash
npm run test:load
```

```
Firing 500 simultaneous reservations ...

Outcomes
  201 OK                       1
  409 INSUFFICIENT_STOCK       499

Elapsed            214 ms
Units accounted    1 (never more than 1)

PASS — no overselling.
```

---

## The concurrency story

This is the heart of the challenge, so it is worth being precise about what the risk actually
is in Node.

### Why a lock is needed at all

JavaScript runs one callback at a time, so a _synchronous_ read-modify-write is already
atomic. A reservation is not synchronous. It loads the aggregate, decides, and saves — and
every `await` in between yields the event loop:

```
request A  load() ──────────▶ sees available = 1 ─┐
request B  load() ──────────▶ sees available = 1  │   both read before either wrote
request A                                         └─▶ save(reserved)
request B                                            ─▶ save(reserved)     ← oversold
```

Anyone who claims "Node is single-threaded, so there is no race" has not looked at where the
`await` points are. The window is small, not absent — and a flash sale is precisely the
traffic pattern that finds small windows.

### The chosen technique: a fair, per-key async mutex

[KeyedMutex](packages/server/src/infrastructure/keyedMutex.ts) serialises the whole
critical section for one product:

```
lock(product) → load aggregate → pure domain transition → save → unlock
```

| Decision                         | Why                                                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Per product, not global**      | Contention is only ever real between buyers of the _same_ item. A global lock would queue the whole catalogue behind whatever is trending.                              |
| **FIFO queue**                   | Waiters chain onto a per-key promise tail, so they are served in arrival order. No caller can be starved by a stream of newcomers.                                      |
| **Acquire timeout**              | A waiter gives up after `LOCK_ACQUIRE_TIMEOUT_MS` with a _transient_ `503 SERVICE_BUSY`. An unbounded queue of requests the client already abandoned is its own outage. |
| **Released in `finally`**        | A throwing critical section can never wedge a product permanently.                                                                                                      |
| **Keys are forgotten when idle** | The lock table does not grow with the size of the catalogue.                                                                                                            |
| **Behind a `Lock` interface**    | Swapping in Redis or a database advisory lock is one file; nothing above the interface knows which it is.                                                               |

One operational note on that timeout: it bounds **queueing**, not the critical section, so it
must be set against the expected queue depth. With the in-memory repository the whole queue
drains in microtasks — measured at 3 000 simultaneous buyers, no waiter ever reaches even a
1 ms budget — so today it is a safety net rather than a live mechanism. It becomes load-bearing
the moment the critical section does real I/O (a database round trip inside the lock), and at
that point it should be tuned deliberately rather than inherited.

### Why not the alternatives

| Alternative                                          | Why not here                                                                                                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Optimistic concurrency (compare-and-set + retry)** | Works, and scales better under low contention. Under a flash sale _every_ request collides, so it degenerates into a retry storm — the worst case is exactly the case we are designing for. |
| **A single global mutex**                            | Correct but needlessly serial: unrelated products would block each other.                                                                                                                   |
| **Atomic counter only**                              | A counter can prevent the oversell but cannot express a _hold_ that expires, nor the lifecycle the challenge asks for.                                                                      |
| **Transactional database**                           | The right answer in production, and the structure here is built for it — but the challenge specifies in-memory inventory.                                                                   |

### Beyond one process

The mutex guards one Node process. Across several instances the invariant must be enforced
where the state lives:

```sql
-- Postgres: the database refuses the oversell, whichever instance asks.
UPDATE products
   SET reserved = reserved + $qty
 WHERE id = $id
   AND total_stock - confirmed_sales - reserved >= $qty
RETURNING reserved;      -- zero rows updated  ⇒  INSUFFICIENT_STOCK
```

or a Redis Lua script that checks and decrements in one atomic step. Either plugs in behind
the existing [Lock](packages/server/src/application/ports.ts) / `InventoryRepository`
interfaces without touching a line of domain logic.

### Expiry is driven by the clock, not by a job

A background sweeper that has not run yet must never be able to cause an oversell — or to
withhold stock from a buyer who should have it. So expiry is **evaluated**, not **scheduled**:

```ts
const isHoldingStock = (r: Reservation, now: Date): boolean =>
  r.status === 'ACTIVE' && r.expiresAt.getTime() > now.getTime();
```

The instant a hold lapses it stops counting against availability, everywhere, with no job
involved. [ExpirySweeper](packages/server/src/application/expirySweeper.ts) exists only to
write `EXPIRED` onto the record and to forget old reservations so memory stays bounded. If it
is late, paused or dead, the system is still correct.

---

## Architecture

```
packages/
├── shared/      Wire contracts (zod schemas + inferred types) used by both sides
├── server/
│   ├── domain/           Pure business rules. No I/O, no framework, no clock of its own.
│   ├── application/      Use-case orchestration + the ports it needs from the world.
│   ├── infrastructure/   Lock, repository, clock, ids, tokens, logging.
│   ├── http/             Express: parse, authenticate, delegate, respond.
│   └── config/           Environment validated once, at startup.
└── web/         React storefront + concurrency lab
```

Dependencies point inward. `domain/` imports nothing but `domain/` and the shared contract;
`application/` depends on interfaces it declares itself; only
[container.ts](packages/server/src/container.ts) knows which concrete class is which.

### Request flow

```
POST /api/v1/reservations
  │
  ├─ helmet · CORS allowlist · request id · 4 kB body limit · rate limit   (http/)
  ├─ authenticate: verify signed session → userId                          (http/)
  ├─ validate: zod, strict — unknown fields rejected                       (http/)
  │
  ├─ ReservationService.reserve                                            (application/)
  │    └─ lock('product:<id>')
  │         ├─ idempotency replay check
  │         ├─ repository.findById
  │         ├─ Inventory.reserve  ← the only place the rule is decided     (domain/)
  │         └─ repository.save
  │
  └─ 201 { reservation, product }      or a typed error through one handler
```

### Why the aggregate is immutable

[Inventory](packages/server/src/domain/inventory.ts) never mutates. Every transition
returns a new instance and the caller decides whether to persist it. That means the rules are
testable with no setup at all, a failed transition cannot leave half-applied state behind,
and the lock has one obvious job: make load-transition-save atomic.

### Error classification

Every failure is deliberately classified as **transient** (retry is sensible) or
**permanent** (retrying is harmful noise), carries its own HTTP mapping, and carries
structured context for the logs:

| Error                           | Status | Code                         | Class             |
| ------------------------------- | ------ | ---------------------------- | ----------------- |
| `InsufficientStockError`        | 409    | `INSUFFICIENT_STOCK`         | permanent         |
| `ReservationNotActiveError`     | 409    | `RESERVATION_NOT_ACTIVE`     | permanent         |
| `IdempotencyKeyConflictError`   | 409    | `IDEMPOTENCY_KEY_CONFLICT`   | permanent         |
| `ReservationLimitExceededError` | 429    | `RESERVATION_LIMIT_EXCEEDED` | permanent         |
| `LockTimeoutError`              | 503    | `SERVICE_BUSY`               | **transient**     |
| `ProductNotFoundError`          | 404    | `PRODUCT_NOT_FOUND`          | permanent         |
| `UnauthenticatedError`          | 401    | `UNAUTHENTICATED`            | permanent         |
| `InvariantViolationError`       | 500    | `INTERNAL_ERROR`             | permanent (a bug) |

Nothing is ever swallowed: every error passes through one handler
([errorHandler.ts](packages/server/src/http/middleware/errorHandler.ts)) that logs it with
the request id and returns a safe body with no stack trace.

---

## API reference

Base path `/api/v1`. All bodies are JSON.

| Method | Path                        | Auth   | Purpose                          |
| ------ | --------------------------- | ------ | -------------------------------- |
| `GET`  | `/health`                   | –      | Liveness                         |
| `POST` | `/sessions`                 | –      | Open an anonymous signed session |
| `GET`  | `/products`                 | –      | Catalogue with live availability |
| `GET`  | `/products/:productId`      | –      | One product's stock position     |
| `POST` | `/reservations`             | Bearer | Place a hold                     |
| `GET`  | `/reservations`             | Bearer | Your reservations                |
| `GET`  | `/reservations/:id`         | Bearer | One of your reservations         |
| `POST` | `/reservations/:id/confirm` | Bearer | Complete the purchase            |
| `POST` | `/reservations/:id/cancel`  | Bearer | Release the hold                 |

### Walkthrough

```bash
API=http://localhost:4000/api/v1

# 1. Open a session.
TOKEN=$(curl -sX POST $API/sessions | jq -r .token)

# 2. Place a hold. The response carries the resulting stock position.
curl -sX POST $API/reservations \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: checkout-0001' \
  -d '{"productId":"flash-sale-single","quantity":1}' | jq
```

```json
{
  "reservation": {
    "reservationId": "0b6f1d2e-...",
    "productId": "flash-sale-single",
    "userId": "user_a1b2...",
    "quantity": 1,
    "status": "ACTIVE",
    "createdAt": "2026-10-14T09:00:00.000Z",
    "expiresAt": "2026-10-14T09:02:00.000Z"
  },
  "product": {
    "productId": "flash-sale-single",
    "name": "Limited Edition Sneaker (1 left)",
    "totalStock": 1,
    "confirmedSales": 0,
    "activeReservations": 1,
    "available": 0
  }
}
```

```bash
# 3. Complete it — or let the two minutes lapse and lose the hold.
curl -sX POST $API/reservations/$ID/confirm -H "Authorization: Bearer $TOKEN" | jq
```

### Error shape

Every failure, from any route, has the same body:

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "This item is sold out."
  },
  "requestId": "b0b1e0e6-..."
}
```

Clients branch on `code`; `message` is safe to show a user and free to change. `requestId`
is also returned in the `x-request-id` header and appears on every related log line.

### Idempotency

`POST /reservations` accepts an optional `Idempotency-Key` header. Retrying the same request
with the same key returns the original reservation instead of placing a second hold — which
matters exactly when it is hardest to reason about: a client that timed out and retried
during a sale.

Replaying a key with a _different_ body is a `409 IDEMPOTENCY_KEY_CONFLICT` rather than a
silent wrong answer. Keys are scoped per user, so one client can never replay another's.

---

## Testing

```bash
npm test                 # everything
npm run test:coverage    # with coverage thresholds (85%)
npm run test:load        # 500 real HTTP requests at a running server
```

**132 tests.** The suite is organised by what it is trying to prove, not by file layout.

### 1. The race condition — proved, not assumed

[tests/concurrency/race-condition.test.ts](packages/server/tests/concurrency/race-condition.test.ts)

The first test in the file **removes the lock and demonstrates the bug**:

```ts
it('is incorrect without a lock: many buyers are told they won the last unit', async () => {
  const harness = buildHarness({ lock: new NoopLock(), totalStock: 1 });

  const outcome = await stampede(harness, 500);

  expect(outcome.succeeded).toBeGreaterThan(1); // many winners, one unit
  expect(accountedFor).not.toBe(outcome.succeeded); // and the writes clobbered each other
});
```

This matters. A test that only asserts the happy path passes against code that oversells on a
slower machine. Showing that the unlocked version _does_ fail is what makes the locked
version's result meaningful.

Then the same stampede with the real lock:

```ts
expect(outcome).toEqual({ succeeded: 1, soldOut: 499, other: 0 });
```

Also covered: exactly `n` winners for `n` units of stock, a mixed reserve/confirm/cancel
storm that must leave the counter exact, and proof that buyers of _different_ products are
not serialised behind each other.

### 2. The same scenario end to end

[tests/concurrency/flash-sale-http.test.ts](packages/server/tests/concurrency/flash-sale-http.test.ts)
drives 500 requests through the **entire HTTP stack** — middleware, auth, routes, service,
lock, repository — each with its own signed session, so neither the per-user hold cap nor the
per-user rate budget can be mistaken for the thing preventing the oversell.

It also proves the sale re-opens correctly: advance the clock past the hold window, fire
another 500, and exactly one new buyer wins.

### 3. Determinism: expiry without waiting

Time is a dependency ([Clock](packages/server/src/application/ports.ts)), so a two-minute
hold is tested in microseconds and never flakes:

```ts
const { inventory } = reserveOne(inventoryWith(1));

expect(inventory.availableStock(at(HOLD_MS - 1))).toBe(0); // still held
expect(inventory.availableStock(at(HOLD_MS))).toBe(1); // released, no job ran
```

No test sleeps. No test depends on another test's state.

### 4. Unit tests for the rules

[tests/unit/inventory.test.ts](packages/server/tests/unit/inventory.test.ts) — 32 tests
covering the availability formula, rejection rather than clamping, the per-user hold cap,
idempotent confirm and cancel, "a confirmed purchase is never reversed", lapsed holds, and
compaction.

[tests/unit/keyedMutex.test.ts](packages/server/tests/unit/keyedMutex.test.ts) — mutual
exclusion, FIFO fairness, per-key independence, release on throw, acquire timeout, and that
the queue keeps moving after a waiter gives up.

[tests/unit/security.test.ts](packages/server/tests/unit/security.test.ts) — token forgery,
wrong-secret rejection, expiry, store eviction, and the configuration guard that refuses to
start production without a secret.

### 5. HTTP contract tests

[tests/integration/api.test.ts](packages/server/tests/integration/api.test.ts) — 37 tests
against the real app via supertest. For each endpoint: happy path, validation failure, auth
failure, domain failure. Plus hygiene: no stack traces, no `x-powered-by`, hardening headers
present, untrusted CORS origins not reflected, client-supplied request ids ignored.

### 6. Frontend

[packages/web/tests](packages/web/tests) — the client's contract parsing and error mapping,
and App-level tests that render the real component tree against a fake network.

### How to review this yourself

| To check                                  | Run                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| The headline guarantee                    | `npx vitest run --project server tests/concurrency`                                     |
| The race actually exists without the lock | Comment out the `KeyedMutex` in `container.ts`, run `tests/concurrency` — watch it fail |
| Expiry logic                              | `npx vitest run --project server tests/unit/inventory.test.ts -t expiry`                |
| The API surface                           | `npx vitest run --project server tests/integration`                                     |
| Real sockets, real process                | `npm run dev:server:demo` then `npm run test:load`                                      |
| By hand                                   | Open the storefront, run the concurrency lab at 500 buyers                              |

### Testing it by hand

Two documents, depending on how much time you have:

| Document                                             | What it is                                                                                                                                                                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [docs/manual-test-plan.md](docs/manual-test-plan.md) | The formal plan: 67 numbered cases across nine suites, each with preconditions, exact commands and an unambiguous expected result, plus a result sheet and sign-off criteria. ~45 minutes for a full pass, ~10 for a smoke pass. |
| [docs/manual-testing.md](docs/manual-testing.md)     | The same ground as a narrative tour, if you just want to drive it and look around.                                                                                                                                               |

---

## Security

Security was treated as a requirement, not a decoration. Every item below is enforced in code
and covered by a test.

### Input

- **Everything is validated at the boundary** with zod, and request schemas are `.strict()` —
  unknown fields are _rejected_, not ignored, so a client cannot smuggle `userId` or
  `totalStock` into an object spread.
- **Path parameters are validated too**, against a bounded `[A-Za-z0-9_-]{1,64}` charset.
  They end up in lock keys, log lines and store lookups; `../../etc/passwd` never gets that far.
- **Quantities are bounded** (`1..10`) and re-asserted inside the domain, which refuses to
  trust that the boundary did its job.
- **Bodies are capped at 4 kB**, rejected by the parser before any route runs.

### Identity and access

- **Sessions are HMAC-SHA256 signed**, with the expiry inside the signed payload so it cannot
  be extended, and verified with `timingSafeEqual` so signature checks leak no timing.
- **No credentials anywhere.** The system needs to know _which_ buyer is acting, not who they
  are; a challenge project has no business storing passwords.
- **Authorisation is enforced in the domain**, not only on the route
  ([Inventory.requireReservationOwnedBy](packages/server/src/domain/inventory.ts)). A future
  caller that bypasses the HTTP layer still cannot touch another user's reservation.
- **Ownership failures are reported as `404`, not `403`.** A distinct 403 would turn the
  endpoint into an existence oracle for other users' reservations. The real reason is logged,
  never returned.
- **Reservation ids are cryptographically random UUIDv4**, so they cannot be guessed or
  enumerated.

### Abuse and availability

- **Rate limiting on two budgets**: a wider one for catalogue reads, a tighter one for
  state-changing calls. Keyed by authenticated user where one exists, falling back to IP — so
  one attacker behind many addresses still gets one budget, and many genuine buyers behind one
  corporate NAT are not punished for each other.
- `**trust proxy` is off by default.** Trusting `X-Forwarded-For` unconditionally lets any
  client spoof its IP straight past the limiter.
- **Bounded memory everywhere**: the idempotency store has a TTL _and_ a hard entry cap with
  oldest-first eviction; the sweeper forgets terminal reservations; the lock table forgets
  idle keys.
- **The lock has an acquire timeout**, so pathological contention fails fast and transiently
  instead of queueing requests nobody is waiting for any more.

### Output and transport

- **No stack traces, driver messages or internal text ever reach a client.** Unrecognised
  errors become a flat 500 with a correlation id; the detail goes to the logs.
- `**helmet` security headers**, and `x-powered-by` disabled — free reconnaissance denied.
- **CORS is an explicit origin allowlist.** Reflecting whatever `Origin` arrives would make
  the API callable from any site a user happens to visit. Credentials are off: identity
  travels in the `Authorization` header, so no cookies are needed and CSRF has no surface.
- **Request ids are always server-generated.** Echoing a client-supplied id would let a caller
  forge or collide with another request's identity in the logs.
- **Logs are redacted at the logger**, not at each call site: `authorization`, `cookie`,
  `token`, `password` and `secret` are censored centrally, so a future careless log line
  cannot leak a credential.

### Secrets and configuration

- **No secrets in source control.** `SESSION_SECRET` comes from the environment, is required
  to be ≥32 characters, and **production refuses to start without it** — with a message that
  tells you how to generate one. Outside production an ephemeral random secret is used, so no
  weak default is ever committed.
- **Configuration is validated once at startup** and never read from `process.env` again. A
  malformed value is a startup failure, not a surprise under load.

### In the browser

- **The bearer token lives in React state only** — not `localStorage`, not a cookie. It dies
  with the tab. Anything persisted is reachable by any script that manages to run on the page.
- **Responses are parsed through the published schemas**, so a malformed or hostile response
  cannot flow unchecked into the UI.

### Known limits

Stated plainly, because a security section that claims completeness is not credible:

- Inventory is in memory. A restart restores the seed catalogue. Several hosts still need
  a shared store.
- Rate limiting is per process. Multiple instances need a shared store (`express-rate-limit`
  supports Redis).
- There is no payment, no PII, and no audit trail. All three would need their own design.
- Sessions are anonymous by design; a real system needs account auth, and reservations would
  need to be bound to it.

---

## Configuration

Every variable is validated at startup. Defaults are safe; nothing is required outside
production.

`npm run dev` keeps stock in memory, which is what Level 1 of the challenge specifies. A
restart puts the seed catalogue back.

| Variable                   | Default                 | Purpose                                          |
| -------------------------- | ----------------------- | ------------------------------------------------ |
| `NODE_ENV`                 | `development`           | `production` enables strict secret checks        |
| `PORT`                     | `4000`                  | HTTP port                                        |
| `LOG_LEVEL`                | `info`                  | pino level                                       |
| `SESSION_SECRET`           | random (dev)            | HMAC key. **Required in production**, ≥32 chars  |
| `SESSION_TTL_MS`           | `86400000`              | Session lifetime                                 |
| `CORS_ALLOWED_ORIGINS`     | `http://localhost:5173` | Comma-separated exact origins                    |
| `RESERVATION_HOLD_MS`      | `120000`                | How long a hold lasts                            |
| `RESERVATION_RETENTION_MS` | `3600000`               | How long terminal reservations stay queryable    |
| `SWEEP_INTERVAL_MS`        | `5000`                  | Expiry sweeper cadence                           |
| `LOCK_ACQUIRE_TIMEOUT_MS`  | `5000`                  | Before a waiter gives up with `503 SERVICE_BUSY` |
| `IDEMPOTENCY_TTL_MS`       | `600000`                | How long a key is remembered                     |
| `IDEMPOTENCY_MAX_ENTRIES`  | `50000`                 | Hard cap on remembered keys                      |
| `RATE_LIMIT_WINDOW_MS`     | `60000`                 | Rate limit window                                |
| `RATE_LIMIT_MAX`           | `300`                   | Reads per window                                 |
| `RATE_LIMIT_WRITE_MAX`     | `60`                    | Writes per window                                |
| `BODY_LIMIT`               | `4kb`                   | Maximum request body                             |
| `TRUST_PROXY`              | `false`                 | Enable only behind a trusted proxy               |

---

## Design decisions and trade-offs

**Reservations reject rather than clamp.** Asking for 3 when 2 remain fails. Quietly
reserving 2 is a different purchase from the one the user asked for.

`**available` is derived, never stored.** It is computed from its three parts on every read,
so it cannot drift from them. The cost is an O(reservations) walk per product; the benefit is
that one entire class of bug — a cached counter disagreeing with reality — cannot occur.

**Confirm and cancel are idempotent; cross-state transitions are not.** Confirming an
already-confirmed reservation returns it unchanged (a retried click is not a second purchase).
Cancelling a _confirmed_ one is a `409` — "confirmed purchases cannot be reversed" is a rule,
not a race.

**An expired reservation that the user then cancels settles as `EXPIRED`, not `CANCELLED`.**
The record should say what actually happened.

**The in-memory repository is deliberately async.** A synchronous fake would hide the very bug
this system exists to prevent — incorrect code would pass its tests.

**There is a per-user cap of 3 active holds per product.** Without it, one script could hold
an entire drop hostage for two minutes at a time without buying anything.

**The frontend polls rather than caching optimistically.** During a flash sale the number on
screen is stale the moment it is drawn; showing a stock count the server would not honour is
worse than showing it a second late.

---

## What production would add

Roughly in priority order:

1. **Postgres for more than one host** — the store is in memory, as the challenge requires.
   Across hosts the same guard belongs in Postgres, as the conditional `UPDATE` above.
2. **A distributed lock or DB-enforced invariant** — the `Lock` interface is already the seam.
3. **Metrics and tracing** — reservation attempts, conflicts, lock wait time, hold-to-confirm
   conversion; OpenTelemetry spans across the critical section.
4. **A durable queue for expiry** at scale, instead of an interval sweeper per instance.
5. **Real authentication** and reservations bound to accounts.
6. **A waiting room** — for a genuine drop, the honest answer to 500 000 concurrent buyers is
   to admit them in batches rather than to serve 499 999 errors very quickly.

---

## Commands

| Command                     | What it does                                        |
| --------------------------- | --------------------------------------------------- |
| `npm run dev`               | API + storefront together                           |
| `npm run dev:server:demo`   | API with rate limits relaxed, for large simulations |
| `npm run build`             | Build all packages                                  |
| `npm test`                  | All tests                                           |
| `npm run test:coverage`     | Tests with coverage thresholds                      |
| `npm run test:load`         | 500 real HTTP requests at a running server          |
| `npm run lint` / `lint:fix` | ESLint (type-aware, strict)                         |
| `npm run typecheck`         | `tsc` across every package                          |
| `npm run format`            | Prettier                                            |
| `npm run verify`            | Format check + lint + typecheck + tests             |

---

## AI disclosure

I used Claude and Cursor as assistants. The design, the implementation, the automated
tests, and the manual documents in `docs/` are mine. I ran the suites and the hand plan.

Claude helped me plan the application structure, and look for standard considerations
the brief does not spell out but that keep the system consistent over time: where the
domain ends and the infrastructure starts, a restart restoring a known catalogue,
expiry decided by the clock rather than by a background job, and a failure reported
without corrupting stock.

Cursor helped me with:

- Checking the running server stays on the in-memory catalogue the challenge specifies
- Drafting and editing this README, including this disclosure
- Wording in the manual test plan when the store description changed

I decided what stayed.
