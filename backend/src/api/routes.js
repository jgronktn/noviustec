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
import { archiveAttachments, resolveDocumentPath } from "../storage/documents.js";
import { getTransaction, addDocument } from "../ledger/index.js";

// Hardcoded for single-tenant v1. Eventually derived from authenticated session.
const COMPANY_ID = process.env.NOVIUSTEC_COMPANY_ID || "default";

const MIME_BY_EXT = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

const VIEWABLE_MIMES = new Set(Object.values(MIME_BY_EXT));

function pickFirstViewableAttachment(attachments) {
  if (!Array.isArray(attachments)) return null;
  const supported = attachments.filter((a) => {
    if (typeof a?.ContentType !== "string" || typeof a?.Content !== "string") return false;
    const ct = a.ContentType.toLowerCase().split(";")[0].trim();
    return VIEWABLE_MIMES.has(ct);
  });
  if (supported.length === 0) return null;
  const pdfs = supported.filter((a) => a.ContentType.toLowerCase().startsWith("application/pdf"));
  const pool = pdfs.length > 0 ? pdfs : supported;
  pool.sort((a, b) => (b.ContentLength ?? 0) - (a.ContentLength ?? 0));
  return pool[0];
}

function sanitizeForHeader(name) {
  if (!name) return "document";
  return String(name).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
}

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
            reference_number: { type: ["string", "null"], default: null },
            reference_kind: {
              type: ["string", "null"],
              enum: ["invoice", "receipt", "order", "transaction", "confirmation", "other", null],
              default: null,
            },
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

      // Archive every viewable PDF/image (could be multiple — Anthropic
      // emails ship Invoice+Receipt for the same charge). The first
      // record returned is the primary doc (largest; usually the one
      // matching the parser's reference). GL's document_path points
      // to it; full archive list lives in the Documents sheet.
      const reference = req.body.reference_number
        ? { value: req.body.reference_number, kind: req.body.reference_kind ?? "other" }
        : null;
      let archivedDocs = [];
      try {
        archivedDocs = await archiveAttachments({
          companyId: COMPANY_ID,
          logDir,
          sourceFile: row.source_file,
          vendor: req.body.vendor,
          date: req.body.date,
          reference,
          pendingId: row.id,
        });
      } catch (err) {
        req.log.error({ err, pending_id: row.id }, "document archive failed; proceeding anyway");
      }
      const primary = archivedDocs[0] ?? null;

      const { id: transactionId } = await addTransaction({
        vendor: req.body.vendor,
        date: req.body.date,
        amount: req.body.total,
        currency: req.body.currency ?? "USD",
        category: req.body.category,
        payment_source: req.body.payment_source ?? null,
        reference_number: req.body.reference_number ?? null,
        reference_kind: req.body.reference_kind ?? null,
        document_path: primary?.document_path ?? null,
        description: req.body.description ?? "",
        notes: req.body.notes ?? "",
        source_file: row.source_file,
        pending_id: row.id,
        created_by: "user",
      });

      // One Documents row per archived file, all linked to the new GL txn.
      const docIds = [];
      for (const rec of archivedDocs) {
        try {
          const { id } = await addDocument({
            vendor: req.body.vendor,
            date: req.body.date,
            reference_kind: rec.reference_kind,
            reference_number: rec.reference_number,
            filename: rec.filename,
            original_filename: rec.original_filename,
            document_path: rec.document_path,
            txn_id: transactionId,
            pending_id: row.id,
          });
          docIds.push(id);
        } catch (err) {
          req.log.error({ err, file: rec.filename }, "failed to write Documents row");
        }
      }

      await updatePendingStatus(row.id, {
        status: "approved",
        resolution_notes: `→ ${transactionId}`,
      });

      req.log.info(
        {
          pending_id: row.id,
          transaction_id: transactionId,
          vendor: req.body.vendor,
          total: req.body.total,
          reference_number: req.body.reference_number ?? null,
          documents_archived: archivedDocs.length,
          document_ids: docIds,
          primary_document_path: primary?.document_path ?? null,
        },
        "pending approved",
      );

      return {
        pending_id: row.id,
        transaction_id: transactionId,
        document_path: primary?.document_path ?? null,
        documents: archivedDocs.map((r) => ({
          filename: r.filename,
          original_filename: r.original_filename,
          reference_kind: r.reference_kind,
          reference_number: r.reference_number,
          document_path: r.document_path,
        })),
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/documents/pending/:id — preview the document attached to a
  // pending entry BEFORE approval. Reads the base64 attachment out of the
  // saved inbound/upload payload and streams it. For inline-HTML rows (no
  // attachment) returns 404.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get("/api/documents/pending/:id", async (req, reply) => {
    const row = await getPending(req.params.id);
    if (!row) return reply.code(404).send({ error: "Pending entry not found" });
    if (!row.source_file) return reply.code(404).send({ error: "No source file recorded" });

    const payloadPath = path.join(logDir, row.source_file);
    let payload;
    try {
      payload = JSON.parse(await fs.readFile(payloadPath, "utf-8"));
    } catch {
      return reply.code(404).send({ error: "Source payload missing" });
    }
    const att = pickFirstViewableAttachment(payload?.Attachments);
    if (!att) {
      return reply.code(404).send({ error: "No archivable attachment in source payload" });
    }
    const buffer = Buffer.from(att.Content, "base64");
    reply
      .header("Content-Type", att.ContentType)
      .header("Content-Disposition", `inline; filename="${sanitizeForHeader(att.Name)}"`)
      .send(buffer);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/documents/transaction/:txn_id — stream the archived document
  // for an approved GL transaction. Looks up document_path on the row,
  // resolves it safely inside the company's documents/ tree, and streams.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get("/api/documents/transaction/:txn_id", async (req, reply) => {
    const txn = await getTransaction(req.params.txn_id);
    if (!txn) return reply.code(404).send({ error: "Transaction not found" });
    if (!txn.document_path) {
      return reply.code(404).send({ error: "No document archived for this transaction" });
    }
    const absolute = resolveDocumentPath({ companyId: COMPANY_ID, documentPath: txn.document_path });
    if (!absolute) return reply.code(400).send({ error: "Invalid document path" });

    try {
      const buffer = await fs.readFile(absolute);
      const ext = path.extname(absolute).slice(1).toLowerCase();
      const mime = MIME_BY_EXT[ext] || "application/octet-stream";
      reply
        .header("Content-Type", mime)
        .header("Content-Disposition", `inline; filename="${path.basename(absolute)}"`)
        .send(buffer);
    } catch {
      return reply.code(404).send({ error: "Document file missing on disk" });
    }
  });

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
