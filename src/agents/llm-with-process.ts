/**
 * The semantic-analysis LLM client: every call goes to the rapid-llm-proxy
 * daemon's `/api/complete` with an explicit `process` tag.
 *
 * Why there is no SDK: semantic-analysis used to embed `@rapid/llm-proxy`'s
 * in-process `LLMService` — its own provider chain, tier table and model ids,
 * a frozen v1 copy that drifted from the running daemon (retired Copilot model
 * ids, a broken comment the Dockerfile had to patch). Since the T2 egress
 * lockdown the container holds no provider keys, so that chain could only ever
 * reach models through the daemon anyway. Routing is now decided in ONE place:
 * the daemon reads `body.process`, looks up the `bg-<process>` route in
 * `llm-routing.yaml`, and owns provider, band, fallback and token accounting.
 * A call without `process` lands in token-usage as `process='unknown'` and is
 * routed by `defaults.background`, so every call site names one.
 *
 * What the SDK did that callers still need lives here:
 *   - `LLMMetricsTracker` — the per-agent call log wave-controller reads via
 *     `getLLMMetrics()` / `getDetailedCalls()` for the workflow trace.
 *   - An SDK-shaped response (`{ content, model, provider, tokens: { total,
 *     input?, output? }, latencyMs }`), mapped from the proxy's reply.
 *   - Mock mode is the CALLER's concern (`isMockLLMEnabled` / the
 *     SemanticAnalyzer mode resolver): this client always dials the daemon.
 *
 * No `console.*` — callers log through `../logging.js`.
 *
 * @module agents/llm-with-process
 */

import { currentLlmProject } from './llm-project-context.js';

/** Anything that can record a completed call — `LLMMetricsTracker` below,
 *  or a test double. */
export interface MetricsTrackerLike {
  recordCall(
    provider: string,
    model: string,
    tokens: { input: number; output: number; total: number },
    latencyMs: number,
    operationType?: string,
    promptPreview?: string,
    responsePreview?: string,
  ): void;
}

/** One recorded call, the shape wave-controller turns into a trace entry. */
export interface LLMCallRecord {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  operationType?: string;
  timestamp: number;
  promptPreview?: string;
  responsePreview?: string;
}

/** Per-agent call log. Each wave agent owns one, passes it to
 *  `createLLMWithProcess`, and reads it back for the workflow trace. */
export class LLMMetricsTracker implements MetricsTrackerLike {
  private calls: LLMCallRecord[] = [];

  recordCall(
    provider: string,
    model: string,
    tokens: { input: number; output: number; total: number },
    latencyMs: number,
    operationType?: string,
    promptPreview?: string,
    responsePreview?: string,
  ): void {
    this.calls.push({
      provider,
      model,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      totalTokens: tokens.total,
      latencyMs,
      operationType,
      timestamp: Date.now(),
      promptPreview,
      responsePreview,
    });
  }

  getCalls(): LLMCallRecord[] {
    return [...this.calls];
  }

  getProviders(): string[] {
    return [...new Set(this.calls.map((c) => c.provider))];
  }

  getTotalTokens(): number {
    return this.calls.reduce((sum, c) => sum + c.totalTokens, 0);
  }

  reset(): void {
    this.calls = [];
  }
}

/** The request every call site sends. */
export interface LLMWithProcessRequest {
  /** Required: free-form telemetry tag set into `body.process` so the proxy
   *  stores per-call attribution in `.data/llm-proxy/token-usage.db`. */
  process: string;
  /** Standard OpenAI-style messages array. */
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** Optional: task label, recorded as the trace entry's operation type.
   *  The proxy does not route on it — only `process` (and its route's band)
   *  decides the model. */
  taskType?: string;
  /** Optional: per-agent attribution label distinct from `process`. */
  agentId?: string;
  /** Optional: the project (repo id) the call is spent on — the proxy stores
   *  it as `token_usage.project`. Defaults to the enclosing workflow run's
   *  project (llm-project-context.ts). */
  project?: string;
  /** Optional: routing tier (`'standard'` etc). */
  tier?: string;
  /** Optional: per-call token cap. */
  maxTokens?: number;
  /** Optional: sampling temperature. */
  temperature?: number;
  /** Optional: request timeout in ms. Defaults to 60_000 (matches existing
   *  wave-agent call-site default). */
  timeout?: number;
  /** Optional: OpenAI-style response_format passthrough (e.g.
   *  `{ type: 'json_object' }`). */
  responseFormat?: Record<string, unknown>;
}

/** SDK-shaped response, so call sites read `result.tokens.total` etc. */
export interface LLMWithProcessResponse {
  /** LLM-generated text content (matches SDK shape). */
  content: string;
  /** Resolved model name from the proxy (e.g. `claude-haiku-3-5`). */
  model: string;
  /** Resolved provider name from the proxy (e.g. `copilot`, `claude-code`). */
  provider: string;
  /** Token usage — 0 for any count the proxy did not report. */
  tokens: { total: number; input: number; output: number };
  /** End-to-end latency in milliseconds. */
  latencyMs: number;
}

// Phase 42.2 Plan 06 follow-up — port 3033 is the health-API, NOT the LLM
// proxy. The real rapid-llm-proxy `/api/complete` endpoint is served by the
// `rapid-llm-proxy` daemon at port 12435 (host) reached from inside the
// coding-services container via `host.docker.internal`. The container is
// pre-configured with the `LLM_CLI_PROXY_URL=http://host.docker.internal:12435`
// env var by docker/docker-compose.yml.
//
// Resolution order (the same everywhere in coding — see CLAUDE.md):
//   1. RAPID_LLM_PROXY_URL (explicit override for this wrapper)
//   2. LLM_CLI_PROXY_URL (container/host-wide env, set in docker-compose.yml)
//   3. LLM_PROXY_URL (older alternate name)
//   4. `http://localhost:<LLM_CLI_PROXY_PORT>` (port-only override; default 12435)
//
// Every consumer URL gets `/api/complete` appended exactly once.
const DEFAULT_PROXY_PORT = '12435';
const DEFAULT_TIMEOUT_MS = 60_000;

function resolveProxyCompleteUrl(): string {
  const explicit =
    process.env.RAPID_LLM_PROXY_URL ??
    process.env.LLM_CLI_PROXY_URL ??
    process.env.LLM_PROXY_URL;
  const base = explicit ?? `http://localhost:${process.env.LLM_CLI_PROXY_PORT ?? DEFAULT_PROXY_PORT}`;
  return base.endsWith('/api/complete') ? base : `${base.replace(/\/+$/, '')}/api/complete`;
}

/**
 * Call the rapid-llm-proxy `/api/complete` endpoint with an explicit `process`
 * tag in the request body. Returns an SDK-shape response.
 *
 * Throws on non-2xx HTTP responses.
 *
 * Optionally records the call into a passed-in MetricsTrackerLike (typically
 * the agent's `LLMMetricsTracker`) so wave-controller's trace sees the call.
 */
export async function llmWithProcessComplete(
  request: LLMWithProcessRequest,
  metricsTracker?: MetricsTrackerLike,
): Promise<LLMWithProcessResponse> {
  const url = resolveProxyCompleteUrl();
  const timeoutMs = request.timeout ?? DEFAULT_TIMEOUT_MS;

  // Body honors the CLAUDE.md `/api/complete` shape exactly:
  //   { process, messages, taskType? } plus optional routing hints.
  const body: Record<string, unknown> = {
    process: request.process,
    messages: request.messages,
  };
  if (typeof request.taskType === 'string') body.taskType = request.taskType;
  if (typeof request.agentId === 'string') body.agentId = request.agentId;
  const project = request.project ?? currentLlmProject();
  if (project) body.project = project;
  if (typeof request.tier === 'string') body.tier = request.tier;
  if (typeof request.maxTokens === 'number') body.maxTokens = request.maxTokens;
  if (typeof request.temperature === 'number') body.temperature = request.temperature;
  if (request.responseFormat) body.responseFormat = request.responseFormat;

  const startedAt = Date.now();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(
      `llm-with-process: HTTP ${resp.status} ${resp.statusText}: ${text.slice(0, 300)}`,
    );
  }

  const parsed = (await resp.json()) as {
    content?: string;
    model?: string;
    provider?: string;
    tokens?: number | { total?: number; input?: number; output?: number };
    latencyMs?: number;
  };

  // Normalize the proxy's flat `{tokens: number}` into the SDK shape that
  // wave-agent call-sites read as `result.tokens.total`. Falls back to 0 when
  // the proxy returns no token usage info.
  let tokens: { total: number; input: number; output: number };
  if (typeof parsed.tokens === 'number') {
    tokens = { total: parsed.tokens, input: 0, output: 0 };
  } else if (parsed.tokens && typeof parsed.tokens === 'object') {
    tokens = {
      total: typeof parsed.tokens.total === 'number' ? parsed.tokens.total : 0,
      input: typeof parsed.tokens.input === 'number' ? parsed.tokens.input : 0,
      output: typeof parsed.tokens.output === 'number' ? parsed.tokens.output : 0,
    };
  } else {
    tokens = { total: 0, input: 0, output: 0 };
  }

  const response: LLMWithProcessResponse = {
    content: typeof parsed.content === 'string' ? parsed.content : '',
    model: typeof parsed.model === 'string' ? parsed.model : 'unknown',
    provider: typeof parsed.provider === 'string' ? parsed.provider : 'unknown',
    tokens,
    latencyMs:
      typeof parsed.latencyMs === 'number' ? parsed.latencyMs : Date.now() - startedAt,
  };

  // Record into the caller's tracker — wave-controller's trace reads every
  // call from there (getDetailedCalls / getLLMMetrics).
  if (metricsTracker) {
    try {
      metricsTracker.recordCall(
        response.provider,
        response.model,
        response.tokens,
        response.latencyMs,
        request.taskType ?? request.process,
        request.messages[request.messages.length - 1]?.content?.slice(0, 500),
        response.content.slice(0, 500),
      );
    } catch {
      // Metrics recording is best-effort — never fail the LLM call because
      // a tracker push threw.
    }
  }

  return response;
}

/** Convenience factory — bind a `process` tag (and optional metrics tracker)
 *  once and return a partial client. Each wave-agent constructs its own
 *  (`process='wave-analysis-wave1'` etc.) so call-sites don't repeat the tag.
 *
 *  Pass the agent's `LLMMetricsTracker` so its `getDetailedCalls()`
 *  consumers see the calls.
 *
 *  Phase 52 D-06 — the returned `complete()` accepts an optional per-call
 *  `process` override that, when set, supersedes the construction-time
 *  `processTag` default. This unlocks per-sub-step process tag granularity
 *  (e.g. wave-1 enrich vs analyze vs observation-retry) without breaking
 *  any existing wave-level caller (they simply don't pass `process` and
 *  inherit the bound default). The override flows through to
 *  `llmWithProcessComplete` body.process verbatim, so the proxy stores the
 *  call under the sub-step tag instead of the wave-level tag.
 */
export function createLLMWithProcess(
  processTag: string,
  metricsTracker?: MetricsTrackerLike,
): {
  complete: (
    req: Omit<LLMWithProcessRequest, 'process'> & { process?: string },
  ) => Promise<LLMWithProcessResponse>;
} {
  return {
    complete: (req) =>
      llmWithProcessComplete({ ...req, process: req.process ?? processTag }, metricsTracker),
  };
}
