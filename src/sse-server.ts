#!/usr/bin/env node
/**
 * SSE-based MCP server for semantic-analysis
 *
 * This server runs as a single persistent process that multiple Claude Code sessions
 * can connect to via HTTP/SSE transport. Designed for containerized deployments.
 */

import express, { Router } from 'express';
import type { Request, Response } from 'express';
import path from 'node:path';
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createKmCoreRouter, GraphKMStore, type GraphKMStoreOptions } from "@fwornle/km-core";
import { createServer } from "./server.js";
import { log, logError } from "./logging.js";
import { setServerInstance, handleToolCall, TOOLS } from "./tools.js";
import { createSSEBroadcaster } from "./workflow-sse-broadcaster.js";
import { subscribe, getState } from "./workflow-state-machine.js";
import { dataPaths, localKbLayout, repositoryRoot } from "./data-paths.js";
import { setKmStoreProvider } from "./storage/km-store-host.js";

const PORT = parseInt(process.env.SEMANTIC_ANALYSIS_PORT || '3848', 10);

// Express app with SSE transport
const app = express();

// CORS middleware — required by browser clients consuming the km-core /api/v1
// REST mount and the /workflow-events SSE endpoint from a different origin
// (Vite dev server at :5173, system-health-dashboard at :3032, browser direct
// access at :3848). Without these headers the browser blocks the response per
// the same-origin policy even when the request succeeds server-side.
// Pre-route placement: must run before app.use(express.json()) so OPTIONS
// preflight requests (which have no body) short-circuit without touching the
// JSON parser.
app.use((req: Request, res: Response, next: express.NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json());

// ---------------------------------------------------------------------------
// Phase 44 Plan 08: km-core /api/v1 REST mount (same-port strategy)
//
// Mount the canonical /api/v1 surface alongside the existing SSE routes
// (/health, /sse, /workflow-events, /messages). km-core ships
// `createKmCoreRouter` as the framework-agnostic factory (44-CONTEXT R-1/R-2);
// consumer constructs its own express Router and attaches it.
//
// Hydration gate (44-RESEARCH Open Q5): 503-until-ready middleware mirrors
// A's pattern (`scripts/observations-api-server.mjs:1178-1183`), so requests
// hitting /api/v1/* before the kmStore finishes opening get a typed error
// instead of crashing.
//
// Restart command: snapshot/restore returns `restartRequired: true` per
// CONTEXT S-2 (no in-process restart — SSE long-lived connections must not
// be killed by snapshot restore). Operator restarts the container via the
// documented `docker-compose restart coding-services` command.
//
// CLAUDE.md mandatory rule: km-core construction MUST pass `ontologyDir`,
// otherwise default-class resolution throws
// `opts.classes omitted but store has no ontology registry`. Paths follow
// the canonical wave-controller convention (.data/knowledge-graph/{leveldb,
// exports} + .data/ontologies inside the container at /coding/).
// ---------------------------------------------------------------------------
const REPOSITORY_PATH = repositoryRoot();

// The graph store lives under the DATA root, not the repo — obs-api on the host
// opens this same LevelDB (hence the documented LOCK contention), so both sides
// MUST derive it from lib/paths or they silently hold two different graphs.
//
// Top-level await is available here (module ESNext, target ES2022) and the store
// has to exist before the routes below are built.
//
// `ontologyDir` deliberately stays under REPOSITORY_PATH: ontologies are shipped
// schema that every install needs an identical copy of, not user data.
const DATA = await dataPaths(REPOSITORY_PATH);
DATA.ensureDataHome();
const kmStore = new GraphKMStore({
  dbPath: DATA.graphDbDir(),
  exportDir: DATA.graphExportsDir(),
  // T4: read every project's export (coding lib/kb/layout.mjs, 'local' mode).
  layout: (await localKbLayout(REPOSITORY_PATH)) as GraphKMStoreOptions['layout'],
  ontologyDir: path.join(REPOSITORY_PATH, '.data', 'ontologies'),
  // No `domains`. It used to say `['coding']`, which was a tenant name in a
  // slot that holds TOPIC names — the only writers of `metadata.domain` set
  // 'development-workflow', 'pattern-analysis', 'cross-analysis'. So it could
  // never match: measured, 3109 of 3109 nodes carry no domain at all, the
  // exporter bucketed every one of them to `general.json` (34 MB, live), and
  // the `coding.json` it materialised has sat at 142 empty bytes since June.
  //
  // It also made this store DISAGREE with obs-api, which opens the same
  // directory and omits `domains` — km-core's `general` fallback
  // (store/persistence.ts:188) papered over it on read. Omitting it here makes
  // both openers resolve the same default, `['general']`.
  //
  // Deliberately NOT `[resolveScope()]`: that would put a tenant name in a
  // topic slot under a different spelling, make the export FILENAME depend on
  // the scope, and give every colleague their own permanently-empty bucket.
  debounceMs: 5000,
});
let kmStoreReady = false;

// Tell the tool handlers that THIS process owns the store, so they borrow it
// instead of opening a second LevelDB handle on the same directory.
//
// `handleToolCall` is imported from ./tools.js and is reachable from
// POST /tool/:name the instant Express starts listening, so this is registered
// at construction rather than after open(): during hydration the correct answer
// is "not ready yet", not "no host". The predicate is deliberately the same one
// the /api/v1 503 gate uses below, so the HTTP gate and the in-process gate
// cannot drift apart and disagree about whether the graph is usable.
setKmStoreProvider(() =>
  kmStoreReady && (kmStore as unknown as { graph?: unknown }).graph ? kmStore : null,
);

const kmRouter = Router();
kmRouter.use((_req: Request, res: Response, next: express.NextFunction) => {
  // 44-RESEARCH Open Q5 + Pitfall 4: gate behind store-open + presence of
  // the in-memory graph. `kmStore.graph` is the durable indicator that
  // `open()` has finished hydrating from LevelDB/JSON; combined with the
  // local `kmStoreReady` flag flipped after `await kmStore.open()`.
  if (!kmStoreReady || !(kmStore as unknown as { graph?: unknown }).graph) {
    res.status(503).json({ error: 'Knowledge graph store not ready' });
    return;
  }
  next();
});
// km-core's RouterLike declares handler params as `never` (an over-restrictive
// contravariant shape that makes the express.Router type technically incompatible
// at the TS-checker level even though the runtime contract is identical).
// Cast through unknown to bridge the two -- functionally a no-op, declaratively
// satisfies the framework-agnostic Router contract.
createKmCoreRouter(kmStore, kmRouter as unknown as Parameters<typeof createKmCoreRouter>[1], {
  ontologyRegistry: kmStore.ontology,
  snapshotDir: DATA.graphExportsDir(),
  restartCommand: 'docker-compose restart coding-services',
});
app.use('/api/v1', kmRouter);
// JSON 404 fallback for unmatched /api/v1/* paths. Without this, an unknown
// path (e.g. a diagnostic typo like /api/v1/health/orphans — the canonical
// orphan route is /api/v1/graph/orphans) falls through to Express's default
// HTML 404, which makes downstream `jq` pipelines fail to parse. Returning a
// typed JSON 404 keeps any curl|jq diagnostic parseable regardless of path.
app.use('/api/v1', (req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    path: req.originalUrl,
    hint: 'Unknown /api/v1 route. Orphan diagnostics use /api/v1/graph/orphans (list) and /api/v1/stats (orphanCount).',
  });
});
process.stderr.write('[sse-server] km-core /api/v1 routes mounted on port ' + PORT + '\n');

// Store transports by session ID
const transports: Record<string, SSEServerTransport> = {};

// Store heartbeat intervals by session ID
const heartbeatIntervals: Record<string, NodeJS.Timeout> = {};

// Heartbeat interval in milliseconds (15 seconds)
const HEARTBEAT_INTERVAL_MS = 15000;

// Server startup time for uptime tracking
const serverStartTime = Date.now();

// Workflow state event broadcaster -- subscribes to state machine transitions
const broadcaster = createSSEBroadcaster();
subscribe(broadcaster.subscriber.bind(broadcaster));

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'semantic-analysis',
    sessions: Object.keys(transports).length,
    activeHeartbeats: Object.keys(heartbeatIntervals).length,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    uptime: Math.floor((Date.now() - serverStartTime) / 1000),
    workflowEventClients: broadcaster.clientCount,
  });
});

// ---------------------------------------------------------------------------
// Plain-JSON tool invocation -- the transport behind `bin/semantic`.
//
// The MCP surface these handlers used to sit behind cost ~12.6 KB of tool schema
// in EVERY context window, for tools that are only ever invoked deliberately.
// The handlers themselves are unchanged; only the way an agent reaches them is.
//
// This must stay in the SSE server process rather than becoming a standalone
// CLI: handleExecuteWorkflow dispatches into the in-process workflow state
// machine that `createSSEBroadcaster()` above is subscribed to, and that
// broadcaster is what feeds the dashboard's /workflow-events view. Running the
// same handler in a one-shot process would start the workflow but leave the UI
// blind to it.
// ---------------------------------------------------------------------------
app.get('/tools', (_req: Request, res: Response) => {
  res.json({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description })) });
});

app.post('/tool/:name', async (req: Request, res: Response) => {
  // Express 5 types route params as string | string[]; this one is always scalar.
  const name = String(req.params.name);

  if (!TOOLS.find((t) => t.name === name)) {
    res.status(404).json({
      error: `Unknown tool: ${name}`,
      available: TOOLS.map((t) => t.name),
    });
    return;
  }

  try {
    const result = await handleToolCall(name, req.body ?? {});

    // handleToolCall returns MCP content blocks; unwrap the text so a CLI can
    // print it directly instead of teaching every caller the MCP envelope.
    const text = Array.isArray(result?.content)
      ? result.content.map((c: any) => (c?.type === 'text' ? c.text : JSON.stringify(c))).join('\n')
      : JSON.stringify(result);

    res.status(result?.isError ? 500 : 200).json({ tool: name, isError: !!result?.isError, text });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(error instanceof Error ? error : new Error(message), `POST /tool/${name}`);
    res.status(500).json({ tool: name, isError: true, text: `Error: ${message}` });
  }
});

// Workflow state event SSE endpoint -- typed state snapshots on every transition
app.get('/workflow-events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Add client -- broadcaster sends initial-state event with current WorkflowState
  broadcaster.addClient(res, getState());

  // Heartbeat every 15s to keep connection alive
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(': heartbeat\n\n');
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    broadcaster.removeClient(res);
  });

  log('New workflow-events SSE client connected', 'info');
});

// SSE endpoint for establishing the stream
app.get('/sse', async (_req: Request, res: Response) => {
  log(`New SSE connection request`, "info");
  try {
    const transport = new SSEServerTransport('/messages', res);
    const sessionId = transport.sessionId;
    transports[sessionId] = transport;

    // Set up heartbeat to keep SSE connection alive
    const heartbeatInterval = setInterval(() => {
      try {
        // Check if response is still writable before sending heartbeat
        if (!res.writableEnded && !res.destroyed) {
          res.write(`:heartbeat ${Date.now()}\n\n`);
        } else {
          // Connection is closed, clean up
          clearInterval(heartbeatInterval);
          delete heartbeatIntervals[sessionId];
        }
      } catch (error) {
        // Connection likely closed, clean up
        clearInterval(heartbeatInterval);
        delete heartbeatIntervals[sessionId];
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatIntervals[sessionId] = heartbeatInterval;

    transport.onclose = () => {
      log(`SSE transport closed for session ${sessionId}`, "info");
      // Clean up heartbeat interval
      if (heartbeatIntervals[sessionId]) {
        clearInterval(heartbeatIntervals[sessionId]);
        delete heartbeatIntervals[sessionId];
      }
      delete transports[sessionId];
    };

    // Also clean up on response close (handles client disconnect)
    res.on('close', () => {
      if (heartbeatIntervals[sessionId]) {
        clearInterval(heartbeatIntervals[sessionId]);
        delete heartbeatIntervals[sessionId];
      }
    });

    const server = createServer();
    await server.connect(transport);

    // Set the server instance for tools to send progress updates
    setServerInstance(server);

    log(`Established SSE stream with session ID: ${sessionId}`, "info");
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`Error establishing SSE stream: ${errorMsg}`, "error");
    if (!res.headersSent) {
      res.status(500).send('Error establishing SSE stream');
    }
  }
});

// Messages endpoint for receiving client JSON-RPC requests
app.post('/messages', async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId) {
    res.status(400).send('Missing sessionId parameter');
    return;
  }

  const transport = transports[sessionId];
  if (!transport) {
    log(`No active transport found for session ID: ${sessionId}`, "error");
    res.status(404).send('Session not found');
    return;
  }

  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`Error handling request: ${errorMsg}`, "error");
    if (!res.headersSent) {
      res.status(500).send('Error handling request');
    }
  }
});

// Start server -- km-core store opens FIRST so the /api/v1 mount is
// usable as soon as `listen` accepts connections. Per CLAUDE.md mandatory
// rule: `ontologyDir` is required (set above) and `open()` hydrates the
// in-memory graph from LevelDB (or JSON fallback per Phase 37 D-22).
(async () => {
  try {
    await kmStore.open();
    kmStoreReady = true;
    log('[sse-server] km-core GraphKMStore opened (REST /api/v1 ready)', 'info');
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`[sse-server] km-core GraphKMStore open failed: ${errorMsg}`, 'error');
    // Continue serving SSE even if km-core fails -- the 503 gate keeps
    // /api/v1/* requests safe until an operator fixes the underlying issue.
  }

  app.listen(PORT, () => {
    log(`Semantic Analysis SSE Server listening on port ${PORT}`, 'info');
    log(`Health check: http://localhost:${PORT}/health`, 'info');
    log(`SSE endpoint: http://localhost:${PORT}/sse`, 'info');
    log(`Workflow events: http://localhost:${PORT}/workflow-events`, 'info');
    log(`km-core REST: http://localhost:${PORT}/api/v1/stats`, 'info');
  });
})();

// Handle shutdown
process.on('SIGINT', async () => {
  log('Shutting down server...', 'info');
  // Clean up all heartbeat intervals
  for (const sessionId in heartbeatIntervals) {
    clearInterval(heartbeatIntervals[sessionId]);
    delete heartbeatIntervals[sessionId];
  }
  // Close all transports
  for (const sessionId in transports) {
    try {
      await transports[sessionId].close();
      delete transports[sessionId];
    } catch (error) {
      log(`Error closing transport for session ${sessionId}`, 'error', error);
    }
  }
  log('Server shutdown complete', 'info');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  log('Received SIGTERM, shutting down...', 'info');
  // Clean up all heartbeat intervals
  for (const sessionId in heartbeatIntervals) {
    clearInterval(heartbeatIntervals[sessionId]);
    delete heartbeatIntervals[sessionId];
  }
  // Close all transports
  for (const sessionId in transports) {
    try {
      await transports[sessionId].close();
      delete transports[sessionId];
    } catch (error) {
      log(`Error closing transport for session ${sessionId}`, 'error', error);
    }
  }
  process.exit(0);
});
