/**
 * Parse a JSON object out of an LLM reply, repairing the one malformation the
 * models actually produce here: raw control characters inside string literals.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Every agent that asks for JSON did the same two things inline: strip the
 * markdown fence, then `JSON.parse`. When the model wrote a literal newline
 * inside a string value — routine in a prose `summary` field — the parse threw
 *
 *     Bad control character in string literal in JSON at position 908
 *
 * and the caller fell back to a placeholder. In wave-analysis that placeholder
 * is the one-sentence component description, which the downstream constraint
 * then rejects as "All observations are single-sentence stubs", taking the
 * entity and its children's parent lookups down with it. A whole component's
 * analysis was being discarded over an unescaped `\n`, and the only trace was
 * a warning nobody read. Observed on 2026-09-07: 5 components in one run.
 *
 * The repair is deliberately narrow. It escapes control characters that appear
 * INSIDE string literals and changes nothing else — no trailing-comma fixing,
 * no quote juggling, no truncation recovery. A reply that is malformed in any
 * other way still fails, loudly, rather than being silently reinterpreted.
 */

/** Outcome of a parse attempt. `repaired` distinguishes clean from salvaged. */
export interface LlmJsonParse<T> {
  /** Parsed value, or null when the reply could not be parsed even after repair. */
  value: T | null;
  /** True when the reply only parsed after control characters were escaped. */
  repaired: boolean;
  /** Parser message when `value` is null. */
  error?: string;
}

/** Strip a leading ```json fence and its closing counterpart. */
function stripFence(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
}

/**
 * Escape raw control characters that sit inside string literals.
 *
 * Walks the text tracking whether we are inside a string, so control
 * characters BETWEEN tokens (the newlines of pretty-printed JSON) are left
 * exactly as they are — only those inside a literal are escaped.
 */
export function escapeControlCharsInStrings(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (const ch of json) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString && ch < ' ') {
      // The three with short escape forms stay readable in a re-serialized
      // payload; anything else becomes a \u escape.
      if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
      continue;
    }
    out += ch;
  }

  return out;
}

/**
 * Parse an LLM reply as JSON, repairing unescaped control characters if the
 * first attempt fails.
 *
 * Never throws: callers decide what a failure means for them.
 */
export function parseLlmJson<T = unknown>(content: string): LlmJsonParse<T> {
  const cleaned = stripFence(content);

  try {
    return { value: JSON.parse(cleaned) as T, repaired: false };
  } catch (first) {
    try {
      return { value: JSON.parse(escapeControlCharsInStrings(cleaned)) as T, repaired: true };
    } catch (second) {
      return {
        value: null,
        repaired: false,
        // The FIRST error describes the reply as the model wrote it, which is
        // the one worth reporting; the second is an artefact of the repair.
        error: first instanceof Error ? first.message : String(second),
      };
    }
  }
}
