/**
 * Secret redaction (design D14, operator-console spec: secrets are never
 * rendered). A redactor replaces every occurrence of a configured secret
 * value with a fixed placeholder.
 */

export const REDACTED = "[redacted]";

export type Redactor = (text: string) => string;

/** Build a redactor for the given secret values. Empty values are ignored. */
export function createRedactor(secrets: readonly string[]): Redactor {
  const values = secrets.filter((s) => typeof s === "string" && s.length > 0);
  return (text: string): string => {
    let out = text;
    for (const secret of values) {
      out = out.split(secret).join(REDACTED);
    }
    return out;
  };
}

/** Redact strings as strings, not JSON syntax (credentials may contain quotes/control characters). */
export function redactStructuredFields(
  fields: Record<string, unknown>,
  redact: Redactor,
): Record<string, unknown> {
  const copy: unknown = JSON.parse(JSON.stringify(fields));
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.map(visit);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [redact(key), visit(item)]),
      );
    }
    return value;
  };
  return visit(copy) as Record<string, unknown>;
}
