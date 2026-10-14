import { randomUUID } from 'node:crypto';
import type { IdGenerator } from '../application/ports.js';

/**
 * Cryptographically random v4 UUIDs.
 *
 * Unguessable identifiers matter here: reservation ids are the only thing
 * standing between an attacker and someone else's reservation, so a sequential
 * or time-ordered id would be a security defect, not a style choice.
 */
export class UuidIdGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}
