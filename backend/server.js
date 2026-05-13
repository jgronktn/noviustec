// server.js
import Fastify from "fastify";
import cors from "@fastify/cors";
import { promises as fs, existsSync } from "node:fs";
import * as path from "node:path";

// Auto-load backend/.env for local dev (`node server.js`). In production,
// systemd loads the same file via EnvironmentFile= — both paths converge.
const ENV_PATH = path.resolve(import.meta.dirname, ".env");
if (existsSync(ENV_PATH)) {
  process.loadEnvFile(ENV_PATH);
}

const { parseReceipt } = await import("./src/parser/index.js");
const { getCategories, getPaymentSources, addPending } = await import("./src/ledger/index.js");

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "127.0.0.1";  // loopback only — nginx fronts it
const LOG_DIR = process.env.LOG_DIR ?? "./inbound-log";

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
  },
  bodyLimit: 30 * 1024 * 1024,  // 30MB to match nginx client_max_body_size
  trustProxy: true,             // honor X-Forwarded-* from nginx
});

// Register CORS — must come before route registrations
await app.register(cors, {
  origin: [
    "https://app.noviustec.com",
    "http://localhost:5500",   // VS Code Live Server default port
    "http://localhost:5173",   // Vite default port
    "http://localhost:3000",   // Other common dev ports
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
});

// Make sure the log directory exists
await fs.mkdir(LOG_DIR, { recursive: true });

// ────────────────────────────────────────────────────────────────────────────
// Health check — hit this from the browser or curl to confirm the chain works
// ────────────────────────────────────────────────────────────────────────────
app.get("/health", async () => ({
  ok: true,
  service: "bookkeeping-api",
  time: new Date().toISOString(),
  uptime_seconds: Math.round(process.uptime()),
  node_version: process.version,
}));

app.get("/api/inbox", async () => {
  const dir = LOG_DIR;
  const files = await fs.readdir(dir);

  const entries = await Promise.all(
    files
      .filter(f => f.endsWith(".json") && !f.endsWith("-meta.json") && !f.endsWith("-parsed.json"))
      .map(async (filename) => {
        const filepath = path.join(dir, filename);
        const stat = await fs.stat(filepath);
        
        // Read just the metadata fields, not the whole payload
        const content = await fs.readFile(filepath, "utf-8");
        const data = JSON.parse(content);
        
        return {
          filename,
          received_at: stat.mtime.toISOString(),
          from: data.From,
          subject: data.Subject,
          attachment_count: data.Attachments?.length ?? 0,
          size_bytes: stat.size,
        };
      })
  );
  
  // Most recent first
  entries.sort((a, b) => b.received_at.localeCompare(a.received_at));
  
  return { count: entries.length, emails: entries };
});

// ────────────────────────────────────────────────────────────────────────────
// Echo endpoint — verifies that nginx is forwarding headers correctly
// Hit this and inspect the response to confirm X-Forwarded-* are passing through
// ────────────────────────────────────────────────────────────────────────────
app.get("/debug/echo", async (req) => ({
  method: req.method,
  url: req.url,
  ip: req.ip,                       // should be the real client IP via trustProxy
  headers: req.headers,
  query: req.query,
  hostname: req.hostname,
  protocol: req.protocol,           // should be "https" if nginx forwarded correctly
}));

// ────────────────────────────────────────────────────────────────────────────
// Postmark inbound webhook receiver
// Logs to console AND saves the JSON payload to disk for replay/inspection
// ────────────────────────────────────────────────────────────────────────────
app.post("/webhooks/postmark-inbound", async (req, reply) => {
  const body = req.body;

  // Save full payload to disk for later inspection
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `inbound-${stamp}.json`;
  const filepath = path.join(LOG_DIR, filename);
  try {
    await fs.writeFile(filepath, JSON.stringify(body, null, 2));
  } catch (err) {
    req.log.error({ err }, "failed to write inbound log");
  }

  // Pull a few interesting fields for the log line
  req.log.info({
    file: filename,
    from: body?.From,
    to: body?.To,
    subject: body?.Subject,
    messageId: body?.MessageID,
    attachments: body?.Attachments?.length ?? 0,
    bodyBytes: JSON.stringify(body).length,
  }, "inbound email received");

  // Kick off parsing in the background. Don't await — Claude vision calls take
  // seconds and we must return 200 fast (Postmark retries non-200 responses).
  parseAndSaveInBackground(body, filepath, req.log);

  return reply.code(200).send({ ok: true, stored: filename });
});

// ────────────────────────────────────────────────────────────────────────────
// Background receipt parser: runs Claude vision on the saved payload, writes
// the result as a -parsed.json sidecar, and (for parsed/needs_attention)
// adds a row to the ledger's PendingInbox. Errors are logged and persisted,
// not thrown — the webhook has already returned 200 by the time this runs.
// ────────────────────────────────────────────────────────────────────────────
async function parseAndSaveInBackground(payload, originalFilepath, logger) {
  const parsedFilepath = originalFilepath.replace(/\.json$/, "-parsed.json");
  const basename = path.basename(originalFilepath);
  try {
    const [categories, paymentSources] = await Promise.all([
      getCategories().catch(() => []),
      getPaymentSources().catch(() => []),
    ]);

    const result = await parseReceipt(payload, { categories, paymentSources });
    await fs.writeFile(parsedFilepath, JSON.stringify(result, null, 2));

    // Surface for user review: anything that's not a clean terminal state.
    let pendingId = null;
    if (result.status === "parsed" || result.status === "needs_attention") {
      try {
        const { id } = await addPending({ source_file: basename, result });
        pendingId = id;
      } catch (err) {
        logger.error({ err, file: basename }, "failed to add pending row");
      }
    }

    logger.info({
      file: basename,
      pending_id: pendingId,
      status: result.status,
      reason: result.reason,
      vendor: result.proposal?.vendor?.name ?? null,
      total: result.proposal?.total ?? null,
      confidence: result.proposal?.confidence ?? null,
      usage: result.usage,
    }, "receipt parsed");
  } catch (err) {
    const errorRecord = {
      status: "error",
      reason: "parser_exception",
      error: {
        message: err.message,
        stack: err.stack,
        raw_text: err.rawText,
      },
      timestamp: new Date().toISOString(),
    };
    await fs.writeFile(parsedFilepath, JSON.stringify(errorRecord, null, 2)).catch(() => {});
    logger.error({ err, file: basename }, "receipt parser failed");
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Generic POST sink — useful for testing arbitrary webhook setups
// ────────────────────────────────────────────────────────────────────────────
app.post("/debug/sink", async (req) => {
  req.log.info({ body: req.body, headers: req.headers }, "sink received");
  return { ok: true };
});

// ────────────────────────────────────────────────────────────────────────────
// Root — just so you don't get a 404 on /
// ────────────────────────────────────────────────────────────────────────────
app.get("/", async () => ({
  service: "bookkeeping-api",
  endpoints: ["/health", "/debug/echo", "/debug/sink", "/webhooks/postmark-inbound"],
}));

// ────────────────────────────────────────────────────────────────────────────
// Graceful shutdown — systemd sends SIGTERM on `systemctl stop` or restart
// Cleanly close in-flight requests rather than dropping them
// ────────────────────────────────────────────────────────────────────────────
const shutdown = async (signal) => {
  app.log.info(`received ${signal}, shutting down`);
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "error during shutdown");
    process.exit(1);
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ────────────────────────────────────────────────────────────────────────────
// Start
// ────────────────────────────────────────────────────────────────────────────
try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`listening on http://${HOST}:${PORT}`);
} catch (err) {
  app.log.error({ err }, "failed to start");
  process.exit(1);
}
