/**
 * Values the API and its tests must agree on.
 * Changing anything here is a contract change: update the server and the tests in one pass.
 */

/** How long an ACTIVE reservation holds stock before it expires. */
export const RESERVATION_HOLD_MS = 2 * 60 * 1000;

/** Largest quantity a single reservation may request. Bounds the blast radius of a hostile client. */
export const MAX_RESERVATION_QUANTITY = 10;

/** Header a client may send to make reservation creation safely retryable. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** Header carrying the server-generated correlation id of a request. */
export const REQUEST_ID_HEADER = 'x-request-id';

export const API_BASE_PATH = '/api/v1';
