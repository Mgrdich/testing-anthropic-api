/**
 * The docs MCP server over **StreamableHTTP** instead of stdio
 * (`bun run mcp:http-server`). Same capabilities as the stdio entry — both
 * call `buildDocsServer()` — only the transport differs, which is the point:
 * the transport is the one thing that changes when an MCP server stops being
 * a local child process and becomes a network service.
 *
 * `Bun.serve` routes POST / GET / DELETE at `/mcp` into the MCP SDK's
 * `WebStandardStreamableHTTPServerTransport` (fetch `Request` in, `Response`
 * out — no Node adapter needed). Connect the main CLI to it with
 * `bun run dev --mcp-url http://localhost:3100/mcp`.
 *
 * Two modes, and the difference is the demo:
 *   stateful (default) — the transport mints a session id at `initialize`,
 *     the client echoes it in `mcp-session-id`, and the GET SSE stream
 *     carries **server→client** requests. Sampling and roots work, so
 *     `read_doc` serves the client-advertised docs root.
 *   `--stateless`      — `sessionIdGenerator: undefined`. No session, no
 *     server→client channel: `roots/list` is unavailable, so the server falls
 *     back to its hardcoded docs dir (and a sampling-dependent server would
 *     fall back to its raw output). Statelessness is what costs you those
 *     features — nothing else about the server changes.
 *
 * Like the stdio entry it holds **no Anthropic API key** and imports no
 * `@/core`; all diagnostics go to stderr (stdout is free here — unlike stdio,
 * it carries no JSON-RPC — but keeping the habit costs nothing).
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildDocsServer } from "@/mcp/servers/docs-server.ts";

const DEFAULT_PORT = 3100;
/** The single MCP endpoint; every method of the protocol lives on this path. */
const MCP_PATH = "/mcp";
/** Header the spec uses to carry the session id in both directions. */
const SESSION_HEADER = "mcp-session-id";
/**
 * Loopback only. `Bun.serve` defaults to every interface, which would put an
 * unauthenticated file-reading JSON-RPC endpoint on the LAN; this server is a
 * local demo and has no auth of its own.
 */
const BIND_HOST = "127.0.0.1";
/**
 * Idle sessions are swept after this long. A client that goes away without
 * DELETEing its session would otherwise pin its transport *and* its
 * `McpServer` for the lifetime of the process.
 */
const SESSION_IDLE_MS = 10 * 60_000;
const SESSION_SWEEP_MS = 60_000;

type HttpServerArgs = {
  port: number;
  /** `sessionIdGenerator: undefined` — no sessions, no server→client channel. */
  stateless: boolean;
  /** `enableJsonResponse: true` — plain JSON replies instead of SSE streams. */
  jsonResponse: boolean;
};

function note(message: string) {
  process.stderr.write(`http-docs-server: ${message}\n`);
}

function printHelp() {
  process.stderr.write(
    `Usage: bun run mcp:http-server [options]

Serves the docs MCP server over StreamableHTTP at http://localhost:<port>${MCP_PATH}.

Options:
  --port <n>       Port to listen on (default: ${DEFAULT_PORT})
  --stateless      Stateless mode (sessionIdGenerator: undefined). No session
                   id and no server->client stream, so sampling and roots are
                   unavailable and the server uses its fallback docs dir.
  --json-response  enableJsonResponse: true — reply with a single JSON body
                   instead of opening an SSE stream per request.
  -h, --help       Show this help
`,
  );
}

function parseHttpServerArgs(argv: readonly string[]): HttpServerArgs {
  const out: HttpServerArgs = {
    port: DEFAULT_PORT,
    stateless: false,
    jsonResponse: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      case "--stateless":
        out.stateless = true;
        break;
      case "--json-response":
        out.jsonResponse = true;
        break;
      case "--port": {
        const v = argv[++i];
        if (!v) throw new Error("--port requires a value");
        const n = Number.parseInt(v, 10);
        if (!Number.isFinite(n) || n <= 0 || n > 65535) {
          throw new Error(`--port must be a valid port number (got ${v})`);
        }
        out.port = n;
        break;
      }
      default:
        throw new Error(`Unknown option: ${a}`);
    }
  }
  return out;
}

/** A JSON-RPC-shaped error body, which is what MCP clients expect on 4xx/5xx. */
function jsonRpcError(status: number, code: number, message: string) {
  return Response.json(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    { status },
  );
}

/**
 * Run `cleanup` once the response body has been fully delivered. Stateless
 * mode builds a server+transport per request (the transport refuses reuse, to
 * avoid message-id collisions between clients), so each pair has to be closed
 * again — but not before its SSE stream has drained.
 */
function closeWhenDone(res: Response, cleanup: () => void) {
  if (!res.body) {
    cleanup();
    return res;
  }
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    cleanup();
  };
  // Mirror the body rather than `pipeThrough(new TransformStream(...))`: a
  // Transformer only gives us `flush` (the drained case), and the client
  // hanging up mid-stream has to clean up too or the pair leaks.
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done: finished, value } = await reader.read();
      if (finished) {
        controller.close();
        once();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      void reader.cancel(reason);
      once();
    },
  });
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

let args: HttpServerArgs;
try {
  args = parseHttpServerArgs(Bun.argv.slice(2));
} catch (err) {
  // Same shape as the main CLI's parse failure: a typo'd flag gets an
  // `error: …` line plus the usage block, not an unhandled stack trace.
  note(err instanceof Error ? err.message : String(err));
  printHelp();
  process.exit(2);
}

/**
 * Live sessions, keyed by the id the transport minted at `initialize`. Each
 * one owns a transport (and the `McpServer` connected to it) for as long as
 * the client keeps the session — that persistence is exactly what stateless
 * mode gives up.
 */
type Session = {
  transport: WebStandardStreamableHTTPServerTransport;
  server: ReturnType<typeof buildDocsServer>;
  /** Last time a request rode this session; drives the idle sweep below. */
  lastSeen: number;
};

const sessions = new Map<string, Session>();

/**
 * Drop sessions no request has touched for `SESSION_IDLE_MS`, closing both
 * halves. Without this a client that disconnects without a DELETE pins its
 * transport and server forever.
 */
function sweepIdleSessions() {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [id, session] of sessions) {
    if (session.lastSeen > cutoff) continue;
    sessions.delete(id);
    void session.transport.close().catch(() => {});
    void session.server.close().catch(() => {});
    note(`session ${id} swept after idling (${sessions.size} live)`);
  }
}

/** Stateful: initialize mints a session; every later request rides its id. */
async function handleStateful(req: Request): Promise<Response> {
  const sessionId = req.headers.get(SESSION_HEADER);
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      return jsonRpcError(404, -32001, `unknown session id: ${sessionId}`);
    }
    session.lastSeen = Date.now();
    return await session.transport.handleRequest(req);
  }

  // No session id: only an `initialize` POST may open one.
  if (req.method !== "POST") {
    return jsonRpcError(400, -32000, `missing ${SESSION_HEADER} header`);
  }
  const body = await req.json().catch(() => undefined);
  if (!isInitializeRequest(body)) {
    return jsonRpcError(
      400,
      -32000,
      `missing ${SESSION_HEADER} header (only initialize may omit it)`,
    );
  }

  const server = buildDocsServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: args.jsonResponse,
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, server, lastSeen: Date.now() });
      note(`session ${id} initialized (${sessions.size} live)`);
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
      void server.close().catch(() => {});
      note(`session ${id} closed by client (${sessions.size} live)`);
    },
  });
  transport.onclose = () => {
    const id = transport.sessionId;
    if (id && sessions.delete(id)) {
      void server.close().catch(() => {});
      note(`session ${id} transport closed (${sessions.size} live)`);
    }
  };
  await server.connect(transport);
  // The body is already parsed; hand it over so the transport doesn't re-read
  // the (now consumed) request stream.
  return await transport.handleRequest(req, { parsedBody: body });
}

/** Stateless: a throwaway server + transport per request, no session state. */
async function handleStateless(req: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: args.jsonResponse,
  });
  const server = buildDocsServer();
  await server.connect(transport);
  const res = await transport.handleRequest(req);
  return closeWhenDone(res, () => {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  });
}

/**
 * Reject cross-origin browser requests. A page the user visits can resolve a
 * hostname to 127.0.0.1 (DNS rebinding) and reach a loopback-bound server, so
 * binding is not on its own enough: an `Origin` means a browser sent this, and
 * the only browser origins that may drive the endpoint are our own.
 */
function originAllowed(req: Request) {
  const origin = req.headers.get("origin");
  if (origin === null) return true; // non-browser client (curl, the MCP SDK)
  try {
    const { hostname } = new URL(origin);
    return hostname === BIND_HOST || hostname === "localhost";
  } catch {
    return false;
  }
}

const sweeper = setInterval(sweepIdleSessions, SESSION_SWEEP_MS);
// Don't hold the process open for the sweep alone.
sweeper.unref?.();

const http = Bun.serve({
  port: args.port,
  hostname: BIND_HOST,
  // SSE streams sit idle between server→client messages; Bun's 10s default
  // would tear them down mid-session (0 disables the timeout).
  idleTimeout: 0,
  fetch: async (req) => {
    const { pathname } = new URL(req.url);
    if (pathname !== MCP_PATH) {
      return jsonRpcError(404, -32000, `no MCP endpoint at ${pathname}`);
    }
    if (!originAllowed(req)) {
      // Log it: a refusal is either someone probing or a legitimate client
      // being blocked, and both are things you want to see rather than debug
      // from the client's side of a bare 403.
      note(`refused cross-origin request from ${req.headers.get("origin")}`);
      return jsonRpcError(403, -32000, "cross-origin request refused");
    }
    if (
      req.method !== "POST" &&
      req.method !== "GET" &&
      req.method !== "DELETE"
    ) {
      return jsonRpcError(405, -32000, `method not allowed: ${req.method}`);
    }
    try {
      return args.stateless
        ? await handleStateless(req)
        : await handleStateful(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      note(`request failed: ${message}`);
      return jsonRpcError(500, -32603, `internal error: ${message}`);
    }
  },
});

const mode = args.stateless ? "stateless" : "stateful";
const replies = args.jsonResponse ? "json" : "sse";
note(
  `listening on ${http.url.origin}${MCP_PATH} (${mode}, ${replies} replies)`,
);
note(`connect with: bun run dev --mcp-url ${http.url.origin}${MCP_PATH}`);
if (args.stateless) {
  note(
    "stateless mode: no server->client stream, so sampling and roots/list are unavailable (the docs dir falls back to the hardcoded path)",
  );
}
