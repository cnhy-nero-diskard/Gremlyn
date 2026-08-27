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
