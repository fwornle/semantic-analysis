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
 * no quote juggling. A reply that is malformed in any other way still fails,
 * loudly, rather than being silently reinterpreted.
 *
 * ── Truncation is the one other recoverable failure, and it is OPT-IN ───────
 * A reply cut off at the provider's output-token ceiling is not malformed
 * output, it is incomplete output: every element before the cut is intact and
 * only the last one is a fragment. Callers that want the intact prefix pass
 * `{ salvageTruncated: true }` and get it, with `truncated: true` saying the
 * value is PARTIAL. Callers that do not pass it keep the strict contract —
 * because for most callers a half-answer is worse than a failure they can see.
 *
 * Observed on 2026-09-20: wave-2 asked for 4096 output tokens and 11 of 98
 * calls came back at exactly 4096, the reply cut mid-string ("Unterminated
 * string in JSON at position 10295"). Each one discarded a whole component's
 * sub-component analysis — eight complete entities thrown away because a
 * ninth was half-written. The budgets were raised at the call sites; this is
 * the floor under them, because a ceiling can always be reached again.
 */

/** Outcome of a parse attempt. `repaired` distinguishes clean from salvaged. */
export interface LlmJsonParse<T> {
  /** Parsed value, or null when the reply could not be parsed even after repair. */
  value: T | null;
  /** True when the reply only parsed after control characters were escaped. */
  repaired: boolean;
  /**
   * True when `value` came from a TRUNCATED reply whose incomplete tail was
   * dropped. The value is well-formed but PARTIAL — some elements the model
   * intended to emit are missing. Only ever true when the caller opted in.
   */
  truncated: boolean;
  /** Parser message when `value` is null. */
  error?: string;
}

/** Caller-controlled widening of what counts as recoverable. */
export interface LlmJsonParseOptions {
  /**
   * Recover a reply cut off at the output-token ceiling by discarding the
   * final, incomplete element and closing the structures still open around
   * it. Off by default: it trades completeness for availability, and only a
   * caller that can use a partial answer should make that trade.
   */
  salvageTruncated?: boolean;
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
 * Cut a truncated JSON document back to its last COMPLETE element and close
 * the structures left open around it.
 *
 * Walks once, tracking string state and the bracket stack, and remembers the
 * offset just past every `}` / `]` that closed a NESTED structure. That offset
 * is the last point at which the document was whole: everything before it is a
 * finished element, everything after it is the fragment the ceiling cut off.
 *
 * Returns null when there is no such point — a reply truncated before its first
 * nested element closed carries nothing worth keeping, and inventing a value
 * for it would be the silent reinterpretation this module exists to avoid.
 */
export function truncateToLastCompleteElement(json: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let safeEnd = -1;
  let safeStack: string[] = [];

  for (let i = 0; i < json.length; i++) {
    const ch = json[i];

    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') { stack.push(ch === '{' ? '}' : ']'); continue; }
    if (ch === '}' || ch === ']') {
      stack.pop();
      // Only a NESTED close marks a usable cut: closing the outermost
      // structure means the document was never truncated in the first place.
      if (stack.length > 0) {
        safeEnd = i + 1;
        safeStack = [...stack];
      }
      continue;
    }
  }

  if (safeEnd < 0) return null;

  // Drop a dangling separator, then close what is still open, innermost first.
  const head = json.slice(0, safeEnd).replace(/,\s*$/, '');
  return head + safeStack.reverse().join('');
}

/**
 * Parse an LLM reply as JSON, repairing unescaped control characters if the
 * first attempt fails, and — only when the caller asks — recovering the intact
 * prefix of a reply truncated at the output-token ceiling.
 *
 * Never throws: callers decide what a failure means for them.
 */
export function parseLlmJson<T = unknown>(
  content: string,
  options: LlmJsonParseOptions = {},
): LlmJsonParse<T> {
  const cleaned = stripFence(content);

  try {
    return { value: JSON.parse(cleaned) as T, repaired: false, truncated: false };
  } catch (first) {
    // The FIRST error describes the reply as the model wrote it, which is the
    // one worth reporting; anything later is an artefact of a repair attempt.
    const firstMessage = first instanceof Error ? first.message : String(first);

    const escapedText = escapeControlCharsInStrings(cleaned);
    try {
      return { value: JSON.parse(escapedText) as T, repaired: true, truncated: false };
    } catch {
      // fall through to the truncation path
    }

    if (options.salvageTruncated) {
      // Try the escaped text first: a reply can be BOTH truncated and carry an
      // unescaped newline, and the cut is easier to find once strings are sane.
      for (const candidate of [escapedText, cleaned]) {
        const salvaged = truncateToLastCompleteElement(candidate);
        if (salvaged === null) continue;
        try {
          return {
            value: JSON.parse(salvaged) as T,
            repaired: candidate === escapedText && escapedText !== cleaned,
            truncated: true,
          };
        } catch {
          // this candidate did not yield valid JSON; try the next
        }
      }
    }

    return { value: null, repaired: false, truncated: false, error: firstMessage };
  }
}
