#!/usr/bin/env node
/**
 * ChamPDF MCP Server — stdio entry.
 *
 * Spawned by an MCP-aware client (Claude Code, Claude Desktop, Cursor)
 * via stdio. All tool implementations live in ./tools.ts; the HTTP/SSE
 * variant in ./http.ts uses the same registrations.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTools } from './tools.js';

const server = new McpServer({ name: 'champdf', version: '0.1.0' });
registerAllTools(server);

await server.connect(new StdioServerTransport());
