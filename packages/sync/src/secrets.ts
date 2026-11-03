/** One secret found in a record. It never carries the secret itself. */
export interface SecretFinding {
  entity: string;
  id: string;
  /** Dotted path of the field, for example `body` or `acceptance.2`. */
  field: string;
  kind: string;
}

/** Well-known token shapes. Each is specific enough that a match is almost never prose. */
const TOKEN_PATTERNS: readonly { kind: string; re: RegExp }[] = [
  { kind: "private key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { kind: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { kind: "GitHub token", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { kind: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "API key (sk-)", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { kind: "Stripe key", re: /\b[rs]k_live_[A-Za-z0-9]{16,}/ },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

/**
 * `.env`-style lines: an upper-case name that looks secret, `=`, and a value. Lower-case names
 * are left alone so code such as `token = getToken()` in a note does not match.
 */
const ENV_LINE = /^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]*)[ \t]*=[ \t]*(\S.*?)[ \t]*$/gm;
const SECRET_NAME = /SECRET|PASSWORD|PASSWD|TOKEN|(?:^|_)KEY$|CREDENTIAL/;

function envSecret(value: string): boolean {
  for (const [, name = "", raw = ""] of value.matchAll(ENV_LINE)) {
    if (!SECRET_NAME.test(name)) continue;
    const v = raw.replace(/^["']|["']$/g, "");
    // Placeholders and references are not secrets: `$VAR`, `${VAR}`, `<your key>`, `...`.
    if (v.length < 8 || /^[$<]/.test(v) || /^(.)\1*$/.test(v)) continue;
    return true;
  }
  return false;
}

/** The kind of secret in `value`, or undefined when it looks clean. */
export function detectSecret(value: string): string | undefined {
  for (const { kind, re } of TOKEN_PATTERNS) if (re.test(value)) return kind;
  return envSecret(value) ? ".env-style secret" : undefined;
}

/** Every secret in every string field of `record`, nested arrays and objects included. */
export function scanRecord<T extends { id: string }>(entity: string, record: T): SecretFinding[] {
  const found: SecretFinding[] = [];
  const walk = (v: unknown, field: string) => {
    if (typeof v === "string") {
      const kind = detectSecret(v);
      if (kind) found.push({ entity, id: record.id, field, kind });
    } else if (Array.isArray(v)) {
      for (const [i, item] of v.entries()) walk(item, `${field}.${i}`);
    } else if (v !== null && typeof v === "object") {
      for (const [k, item] of Object.entries(v)) walk(item, field ? `${field}.${k}` : k);
    }
  };
  walk(record, "");
  return found;
}
