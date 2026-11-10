/** One secret found in a record. It never carries the secret itself. */
export interface SecretFinding {
    entity: string;
    id: string;
    /** Dotted path of the field, for example `body` or `acceptance.2`. */
    field: string;
    kind: string;
}
/** The kind of secret in `value`, or undefined when it looks clean. */
export declare function detectSecret(value: string): string | undefined;
/** Every secret in every string field of `record`, nested arrays and objects included. */
export declare function scanRecord<T extends {
    id: string;
}>(entity: string, record: T): SecretFinding[];
/**
 * Refuses a write whose text holds a secret, before it reaches the database. Every record that
 * goes to `.sati/` is checked at write time: the export check alone would let a key sit in the
 * local database and in every brief, and then fail every later export. The message names the
 * field and the kind of secret, never the secret.
 */
export declare function refuseSecrets(entity: string, value: Record<string, unknown>): void;
