/**
 * Values that both the API and its clients must agree on.
 * Changing anything here is a contract change: update server, web and tests in one pass.
 */

/** How long an ACTIVE reservation holds stock before it expires. */
export const RESERVATION_HOLD_MS = 2 * 60 * 1000;

/** Largest quantity a single reservation may request. Bounds the blast radius of a hostile client. */
export const MAX_RESERVATION_QUANTITY = 10;

/** Largest number of ACTIVE reservations one user may hold for one product. */
export const MAX_ACTIVE_RESERVATIONS_PER_USER_PER_PRODUCT = 3;

/** Header a client may send to make reservation creation safely retryable. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** Header carrying the server-generated correlation id of a request. */
export const REQUEST_ID_HEADER = 'x-request-id';

export const API_BASE_PATH = '/api/v1';
