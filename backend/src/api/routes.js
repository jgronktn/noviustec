// /api/* routes, registered as a Fastify plugin.
//
// All routes in this plugin are gated by a bearer-token preHandler. The
// /webhooks/* and /health endpoints stay open because they live in the
// parent (server.js) scope — Fastify hooks are scoped to the plugin they
// were registered in.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  getCategories,
  getPaymentSources,
  listPending,
  getPending,
  updatePendingStatus,
  addTransaction,
} from "../ledger/index.js";
import {
  processReceiptPayload,
  buildUploadPayload,
  SUPPORTED_UPLOAD_TYPES,
  MAX_UPLOAD_BYTES,
} from "../processor.js";

// Read at module load. Updates require service restart, which is fine —
// systemd loads .env via EnvironmentFile= and restart picks up changes.
const API_TOKEN = process.env.NOVIUSTEC_API_TOKEN || null;

export default async function apiRoutes(fastify, opts) {
  const logDir = opts.logDir;

  // ─────────────────────────────────────────────────────────────────────────
  // Auth gate: bearer token check for every /api/* route in this plugin.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.addHook("preHandler", async (req, reply) => {
    if (!API_TOKEN) {
      reply.code(503).send({
        error: "NOVIUSTEC_API_TOKEN not configured on server",
      });
      return reply;
    }
    const header = req.headers.authorization || "";
    const m = header.match(/^Bearer\s+(.+)$/);
    if (!m || m[1] !== API_TOKEN) {
      reply.code(401).send({ error: "Unauthorized" });
      return reply;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/inbox — raw Postmark payload listing (kept from earlier).
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get("/api/inbox", async () => {
    const files = await fs.readdir(logDir);
    const entries = await Promise.all(
      files
        .filter(
          (f) =>
            f.endsWith(".json") &&
            !f.endsWith("-meta.json") &&
            !f.endsWith("-parsed.json"),
        )
        .map(async (filename) => {
          const filepath = path.join(logDir, filename);
          const stat = await fs.stat(filepath);
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
        }),
    );
    entries.sort((a, b) => b.received_at.localeCompare(a.received_at));
    return { count: entries.length, emails: entries };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/categories — for UI dropdowns.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get(
    "/api/categories",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            include_archived: { type: "boolean", default: false },
          },
        },
      },
    },
    async (req) => {
      const categories = await getCategories({ activeOnly: !req.query.include_archived });
      return { count: categories.length, categories };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/sources — for UI dropdowns.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get(
    "/api/sources",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            include_archived: { type: "boolean", default: false },
          },
        },
      },
    },
    async (req) => {
      const sources = await getPaymentSources({ activeOnly: !req.query.include_archived });
      return { count: sources.length, sources };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/pending — list pending entries. Default: status=pending.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get(
    "/api/pending",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["pending", "approved", "rejected", "all"],
              default: "pending",
            },
          },
        },
      },
    },
    async (req) => {
      const entries = await listPending({ status: req.query.status });
      return { count: entries.length, entries };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/pending/:id — single row + the full proposal from its sidecar.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get("/api/pending/:id", async (req, reply) => {
    const row = await getPending(req.params.id);
    if (!row) return reply.code(404).send({ error: "Pending entry not found" });

    let proposal = null;
    if (row.source_file) {
      const parsedName = row.source_file.replace(/\.json$/, "-parsed.json");
      const parsedPath = path.join(logDir, parsedName);
      try {
        const text = await fs.readFile(parsedPath, "utf-8");
        proposal = JSON.parse(text);
      } catch {
        proposal = null; // sidecar missing or unreadable
      }
    }
    return { ...row, proposal };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/pending/:id/approve — writes to GL, marks pending approved.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post(
    "/api/pending/:id/approve",
    {
      schema: {
        body: {
          type: "object",
          required: ["vendor", "date", "total", "category"],
          additionalProperties: false,
          properties: {
            vendor: { type: "string", minLength: 1 },
            date: { type: "string" }, // YYYY-MM-DD
            total: { type: "number" },
            currency: { type: "string", default: "USD" },
            category: { type: "string", minLength: 1 },
            payment_source: { type: ["string", "null"], default: null },
            description: { type: "string", default: "" },
            notes: { type: "string", default: "" },
          },
        },
      },
    },
    async (req, reply) => {
      const row = await getPending(req.params.id);
      if (!row) return reply.code(404).send({ error: "Pending entry not found" });
      if (row.status !== "pending") {
        return reply.code(409).send({ error: `Cannot approve a ${row.status} entry` });
      }

      const { id: transactionId } = await addTransaction({
        vendor: req.body.vendor,
        date: req.body.date,
        amount: req.body.total,
        currency: req.body.currency ?? "USD",
        category: req.body.category,
        payment_source: req.body.payment_source ?? null,
        description: req.body.description ?? "",
        notes: req.body.notes ?? "",
        source_file: row.source_file,
        pending_id: row.id,
        created_by: "user",
      });

      await updatePendingStatus(row.id, {
        status: "approved",
        resolution_notes: `→ ${transactionId}`,
      });

      req.log.info(
        { pending_id: row.id, transaction_id: transactionId, vendor: req.body.vendor, total: req.body.total },
        "pending approved",
      );

      return { pending_id: row.id, transaction_id: transactionId };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/upload — direct upload of a receipt PDF/image. Body has the
  // file base64-encoded. Wrapped in a Postmark-shaped synthetic payload so
  // it flows through the exact same parser path as inbound email. Runs
  // synchronously (~5s for the vision call); returns the parsed result.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post(
    "/api/upload",
    {
      schema: {
        body: {
          type: "object",
          required: ["filename", "content_type", "content_base64"],
          additionalProperties: false,
          properties: {
            filename: { type: "string", minLength: 1 },
            content_type: { type: "string", minLength: 1 },
            content_base64: { type: "string", minLength: 1 },
            description: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const { filename, content_type, content_base64, description } = req.body;

      if (!SUPPORTED_UPLOAD_TYPES.has(content_type)) {
        return reply.code(400).send({
          error: `Unsupported content type: ${content_type}. Allowed: ${[...SUPPORTED_UPLOAD_TYPES].join(", ")}`,
        });
      }

      const decodedBytes = Math.floor((content_base64.length * 3) / 4);
      if (decodedBytes > MAX_UPLOAD_BYTES) {
        return reply.code(400).send({
          error: `File too large: ${decodedBytes} bytes (max ${MAX_UPLOAD_BYTES})`,
        });
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const sourceFilename = `upload-${stamp}.json`;
      const payload = buildUploadPayload({ filename, content_type, content_base64, description });

      try {
        await fs.writeFile(
          path.join(logDir, sourceFilename),
          JSON.stringify(payload, null, 2),
        );
      } catch (err) {
        req.log.error({ err, file: sourceFilename }, "failed to write upload payload");
        return reply.code(500).send({ error: "Failed to persist upload" });
      }

      req.log.info(
        { file: sourceFilename, filename, content_type, bytes: decodedBytes },
        "upload received",
      );

      try {
        const { result, pending_id } = await processReceiptPayload({
          payload,
          logger: req.log,
          logDir,
          sourceFilename,
        });
        return {
          pending_id,
          source_file: sourceFilename,
          status: result.status,
          reason: result.reason,
          proposal: result.proposal,
        };
      } catch (err) {
        return reply
          .code(500)
          .send({ error: `Parser failed: ${err.message}`, source_file: sourceFilename });
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/pending/:id/reject — marks pending rejected, no GL row.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post(
    "/api/pending/:id/reject",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            reason: { type: "string" },
            notes: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const row = await getPending(req.params.id);
      if (!row) return reply.code(404).send({ error: "Pending entry not found" });
      if (row.status !== "pending") {
        return reply.code(409).send({ error: `Cannot reject a ${row.status} entry` });
      }

      const parts = [
        req.body.reason ? `Reason: ${req.body.reason}` : "",
        req.body.notes ?? "",
      ].filter(Boolean);
      const resolutionNotes = parts.join(" | ") || "Rejected";

      await updatePendingStatus(row.id, {
        status: "rejected",
        resolution_notes: resolutionNotes,
      });

      req.log.info({ pending_id: row.id, reason: req.body.reason }, "pending rejected");
      return { pending_id: row.id, status: "rejected" };
    },
  );
}
