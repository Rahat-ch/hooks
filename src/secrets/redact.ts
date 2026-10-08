/**
 * Redacting token-like values from text: API keys with well-known prefixes,
 * JWTs, bearer tokens, private key blocks, URL credentials and the values of
 * `password=`-style assignments. Each match becomes `[REDACTED]`; the key,
 * quotes and surrounding text stay, so a redacted command still parses the
 * same way. Paths that hold secrets are recognised by `secretsMatcher` in
 * `./index.ts`, not here.
 *
 * Heuristic by nature: tuned to over-redact secrets rather than miss them,
 * while leaving ordinary commands and prose alone.
 */

export const redacted = "[REDACTED]";

/** A value is everything up to whitespace, a quote or a shell/URL separator. */
const value = String.raw`[^\s"'&;,|<>()\[\]{}]+`;

/** Key names whose value is a secret: `password`, `api_key`, `SECRET_KEY`, `GITHUB_TOKEN`, ... */
const secretKey = String.raw`[A-Za-z0-9_.-]*(?:passw(?:or)?d|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_.-]*`;

/** Replace the whole match. */
const whole: readonly RegExp[] = [
  // Private key blocks (PEM, OpenSSH).
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  // OpenAI / Anthropic style keys: sk-..., sk-proj-..., sk-ant-...
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // GitHub tokens: classic (ghp_, gho_, ghu_, ghs_, ghr_) and fine-grained.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // Slack tokens.
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  // AWS access key ids.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // JWTs: base64url header.payload.signature, header starting {"
  /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
];

/** Keep group 1 (the key or prefix), replace group 2 (the secret). */
const keyed: readonly RegExp[] = [
  // Authorization: Bearer <token>
  /(\bBearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
  // scheme://user:password@host
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(?=@)/gi,
  // "password": "x"  /  'api_key': 'x'
  new RegExp(String.raw`(["']${secretKey}["']\s*:\s*["'])([^"']+)(?=["'])`, "gi"),
  // password=x, --password=x, SECRET_KEY="x", api_key: x
  new RegExp(String.raw`(\b${secretKey}\s*(?:=|:\s)\s*["']?)(${value})`, "gi"),
];

/** Whether a would-be secret is really a placeholder or a plain number (`max_tokens: 1024`). */
const harmless = (secret: string) => secret === redacted || secret.startsWith(redacted) || /^\d+$/.test(secret);

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of whole) result = result.replace(pattern, redacted);
  for (const pattern of keyed) {
    result = result.replace(pattern, (match, prefix: string, secret: string) =>
      harmless(secret) ? match : `${prefix}${redacted}`,
    );
  }
  return result;
}

/** `redactSecrets` applied to every string in a JSON value (object keys are kept). */
export function redactSecretsDeep<T>(input: T): T {
  if (typeof input === "string") return redactSecrets(input) as T;
  if (Array.isArray(input)) return input.map((item) => redactSecretsDeep(item)) as T;
  if (typeof input === "object" && input !== null) {
    return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, redactSecretsDeep(item)])) as T;
  }
  return input;
}
