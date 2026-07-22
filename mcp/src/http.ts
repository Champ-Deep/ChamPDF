#!/usr/bin/env node
/**
 * ChamPDF MCP Server — HTTP / SSE entry.
 *
 * Stateless StreamableHTTP transport so the same process can serve many
 * clients. Designed to be deployed as a Railway service (or any container
 * platform) for users who can't run Node locally.
 *
 * Auth model (intentionally simple for Phase 3):
 *   - Tool calls forward to the ChamPDF v1 API using CHAMPDF_API_KEY from
 *     env. One deployer's key, one quota — this is fine for a single-team
 *     hosted MCP. Multi-tenant per-user keys come later.
 *   - Optional gate: if CHAMPDF_MCP_AUTH_TOKEN is set, every incoming
 *     request must carry `Authorization: Bearer <token>`. Without this
 *     env var the endpoint is open to anyone with the URL.
 *
 * Endpoint:
 *   POST /mcp        — JSON-RPC over StreamableHTTP (server replies inline
 *                      for non-streaming methods, SSE for streaming ones)
 *   GET  /healthz    — plain 200 ok for Railway healthchecks
 *
 * Listens on $PORT (Railway) or 8081 by default.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { registerAllTools } from './tools.js';

const PORT = Number(process.env.PORT ?? 8081);
const HOST = process.env.HOST ?? '0.0.0.0';
const AUTH_TOKEN = process.env.CHAMPDF_MCP_AUTH_TOKEN ?? '';

if (!process.env.CHAMPDF_API_KEY) {
  console.error(
    '[champdf-mcp/http] CHAMPDF_API_KEY is not set. Tool calls will fail with 401.'
  );
}

function authGate(req: Request, res: Response, next: NextFunction): void {
  if (!AUTH_TOKEN) {
    next();
    return;
  }
  const header = req.header('authorization') ?? '';
  const expected = `Bearer ${AUTH_TOKEN}`;
  if (header !== expected) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Missing or invalid Authorization' },
      id: null,
    });
    return;
  }
  next();
}

const app = express();
app.use(express.json({ limit: '50mb' }));

app.get('/healthz', (_req, res) => {
  res.status(200).type('text/plain').send('ok');
});

app.post('/mcp', authGate, async (req: Request, res: Response) => {
  // Stateless: spin up a fresh server + transport per request. Cheap for
  // our use case (no per-session state to keep) and avoids cross-request
  // bleed.
  const server = new McpServer({ name: 'champdf', version: '0.2.0' });
  registerAllTools(server);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  });

  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[champdf-mcp/http] request failed:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : 'Internal error',
        },
        id: null,
      });
    }
  }
});

// Reject GET /mcp and similar with a clear hint
app.all('/mcp', (_req, res) => {
  res
    .status(405)
    .type('text/plain')
    .send('Method Not Allowed. POST JSON-RPC to /mcp.');
});

app.listen(PORT, HOST, () => {
  console.log(
    `[champdf-mcp/http] listening on http://${HOST}:${PORT}/mcp` +
      (AUTH_TOKEN ? ' (auth required)' : ' (no auth — gate the URL!)')
  );
});
