/**
 * Branded identifiers. A `ProductId` is a string at runtime but is not
 * interchangeable with a `UserId` at compile time, so the classic
 * "passed the wrong id to the wrong argument" bug cannot be written.
 */

declare const brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ProductId = Brand<string, 'ProductId'>;
export type ReservationId = Brand<string, 'ReservationId'>;
export type UserId = Brand<string, 'UserId'>;

export const toProductId = (value: string): ProductId => value as ProductId;
export const toReservationId = (value: string): ReservationId => value as ReservationId;
export const toUserId = (value: string): UserId => value as UserId;
