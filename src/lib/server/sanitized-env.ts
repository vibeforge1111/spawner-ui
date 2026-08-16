/**
 * Returns a copy of process.env with sensitive variables removed
 * before passing to child processes. Prevents leaking API keys,
 * tokens, and credentials to spawned subprocesses.
 *
 * Known sensitive patterns are stripped. SPARK_* and SPAWNER_*
 * variables are always passed through since they are local config.
 */

const SENSITIVE_PATTERNS = [
  /API_KEY$/i,
  /SECRET$/i,
  /TOKEN$/i,
  /PASSWORD$/i,
  /CREDENTIAL$/i,
  /PRIVATE_KEY$/i,
];

const SENSITIVE_EXACT_KEYS = new Set([
  'GITHUB_PERSONAL_ACCESS_TOKEN',
  'GITLAB_PERSONAL_ACCESS_TOKEN',
  'SLACK_BOT_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ZAI_API_KEY',
  'KIMI_API_KEY',
  'MINIMAX_API_KEY',
  'OPENROUTER_API_KEY',
  'HF_TOKEN',
  'ELEVENLABS_API_KEY',
]);

const ALWAYS_PASSTHROUGH_PREFIXES = ['SPARK_', 'SPAWNER_', 'NODE_', 'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_', 'TMP', 'TEMP', 'XDG_'];

function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_EXACT_KEYS.has(key)) return true;
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(key));
}

function isAlwaysPassThrough(key: string): boolean {
  return ALWAYS_PASSTHROUGH_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Returns a sanitized copy of process.env safe to pass to child processes.
 * Sensitive keys (API keys, tokens, secrets) are removed.
 * SPARK_*, SPAWNER_*, and system essentials are always included.
 */
export function sanitizedChildEnv(overrides?: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (isAlwaysPassThrough(key) || !isSensitiveKey(key)) {
      result[key] = value;
    }
  }
  if (overrides) {
    Object.assign(result, overrides);
  }
  return result;
}
