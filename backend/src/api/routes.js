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
  ensurePaymentSource,
  listPending,
  getPending,
  updatePendingStatus,
  updatePendingFromParse,
  addTransaction,
  getLedgerPath,
  getDocument,
  getKnownVendors,
} from "../ledger/index.js";
import { parseReceipt } from "../parser/index.js";
import {
  processReceiptPayload,
  buildUploadPayload,
  SUPPORTED_UPLOAD_TYPES,
  MAX_UPLOAD_BYTES,
} from "../processor.js";
import { archiveAttachments, resolveDocumentPath } from "../storage/documents.js";
import {
  getTransaction,
  addDocument,
  attachDocumentsToTransaction,
  addAwaitingPayment,
  listAwaiting,
  getAwaiting,
  markAwaitingPaid,
  findMatchCandidates,
} from "../ledger/index.js";
import { runAgent } from "../agent/loop.js";
import { buildTimelineProps } from "../agent/handlers.js";

// Hardcoded for single-tenant v1. Eventually derived from authenticated session.
const COMPANY_ID = process.env.NOVIUSTEC_COMPANY_ID || "default";
const COMPANY_NAME = process.env.NOVIUSTEC_COMPANY_NAME || "Noviustec";

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

function serializeArchivedDoc(r) {
  return {
    filename: r.filename,
    original_filename: r.original_filename,
    reference_kind: r.reference_kind,
    reference_number: r.reference_number,
    document_path: r.document_path,
  };
}

// Read at module load. Updates require service restart, which is fine —
// systemd loads .env via EnvironmentFile= and restart picks up changes.
const API_TOKEN = process.env.NOVIUSTEC_API_TOKEN || null;

// Kept in sync with the CORS config in server.js. The SSE handler hijacks
// the response (so @fastify/cors's onSend hook is bypassed), so we have to
// echo the same Access-Control-Allow-Origin header manually for the
// browser to accept the streamed response.
const ALLOWED_ORIGINS = new Set([
  "https://app.noviustec.com",
  "http://localhost:5500",
  "http://localhost:5173",
  "http://localhost:3000",
]);

function corsHeadersFor(origin) {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

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
  // GET /api/pending/:id — single row + the full proposal from its sidecar,
  // plus suggested_action and match_candidates for the awaiting workflow.
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

    // Suggest workflow action + surface match candidates for the awaiting flow.
    // The LLM's reference_kind drives the default; the user can override.
    const llmKind = proposal?.proposal?.reference_number?.kind ?? row.reference_kind ?? null;
    let match_candidates = [];
    if (row.vendor && row.total != null) {
      match_candidates = await findMatchCandidates({ vendor: row.vendor, total: row.total });
    }
    let suggested_action;
    if (match_candidates.length > 0) {
      // A receipt-like entry where we already have an awaiting invoice. Suggest match.
      suggested_action = "match";
    } else if (llmKind === "invoice") {
      // Invoice with no prior awaiting → save as awaiting payment.
      suggested_action = "to_awaiting";
    } else {
      suggested_action = "to_gl";
    }

    return { ...row, proposal, suggested_action, match_candidates };
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
            action: {
              type: "string",
              enum: ["to_gl", "to_awaiting", "match"],
              default: "to_gl",
            },
            match_id: { type: ["string", "null"], default: null },
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

      const action = req.body.action ?? "to_gl";

      if (action === "match" && !req.body.match_id) {
        return reply.code(400).send({ error: "match_id required when action=match" });
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

      // ─── Branch 1: save as AwaitingPayment, no GL row ────────────────────
      if (action === "to_awaiting") {
        const { id: awaitingId } = await addAwaitingPayment({
          vendor: req.body.vendor,
          date: req.body.date,
          amount: req.body.total,
          currency: req.body.currency ?? "USD",
          reference_number: req.body.reference_number ?? null,
          reference_kind: req.body.reference_kind ?? null,
          description: req.body.description ?? "",
          notes: req.body.notes ?? "",
          document_path: primary?.document_path ?? null,
          source_file: row.source_file,
          pending_id: row.id,
        });

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
              txn_id: null,
              awaiting_id: awaitingId,
              pending_id: row.id,
            });
            docIds.push(id);
          } catch (err) {
            req.log.error({ err, file: rec.filename }, "failed to write Documents row");
          }
        }

        await updatePendingStatus(row.id, {
          status: "approved",
          resolution_notes: `→ ${awaitingId} (awaiting payment)`,
        });

        req.log.info(
          {
            pending_id: row.id,
            awaiting_id: awaitingId,
            action: "to_awaiting",
            vendor: req.body.vendor,
            total: req.body.total,
            reference_number: req.body.reference_number ?? null,
            documents_archived: archivedDocs.length,
            document_ids: docIds,
          },
          "pending approved as awaiting payment",
        );

        return {
          pending_id: row.id,
          awaiting_id: awaitingId,
          action: "to_awaiting",
          document_path: primary?.document_path ?? null,
          documents: archivedDocs.map(serializeArchivedDoc),
        };
      }

      // ─── Branch 2: match a receipt to an existing AwaitingPayment ─────────
      if (action === "match") {
        const awaiting = await getAwaiting(req.body.match_id);
        if (!awaiting) {
          return reply.code(404).send({ error: `AwaitingPayment row not found: ${req.body.match_id}` });
        }
        if (awaiting.status !== "awaiting") {
          return reply
            .code(409)
            .send({ error: `Cannot match to AwaitingPayment with status=${awaiting.status}` });
        }

        const { id: transactionId } = await addTransaction({
          vendor: req.body.vendor,
          date: req.body.date,
          amount: req.body.total,
          currency: req.body.currency ?? "USD",
          category: req.body.category,
          payment_source: req.body.payment_source ?? null,
          reference_number: req.body.reference_number ?? null,
          reference_kind: req.body.reference_kind ?? null,
          document_path: primary?.document_path ?? awaiting.document_path ?? null,
          description: req.body.description ?? "",
          notes: req.body.notes ?? "",
          source_file: row.source_file,
          pending_id: row.id,
          created_by: "user",
        });

        // Backfill the AwaitingPayment row → paid, link to the new GL txn.
        await markAwaitingPaid(req.body.match_id, { paid_txn_id: transactionId });

        // Backfill Documents rows that were originally linked only to the
        // awaiting row (the invoice PDFs) — now they're also part of this txn.
        await attachDocumentsToTransaction({
          awaiting_id: req.body.match_id,
          txn_id: transactionId,
        });

        // Plus: write Documents rows for THIS pending's archives (the receipt).
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
              awaiting_id: req.body.match_id,
              pending_id: row.id,
            });
            docIds.push(id);
          } catch (err) {
            req.log.error({ err, file: rec.filename }, "failed to write Documents row");
          }
        }

        await updatePendingStatus(row.id, {
          status: "approved",
          resolution_notes: `→ ${transactionId} (matched ${req.body.match_id})`,
        });

        req.log.info(
          {
            pending_id: row.id,
            transaction_id: transactionId,
            matched_awaiting_id: req.body.match_id,
            action: "match",
            vendor: req.body.vendor,
            total: req.body.total,
            documents_archived: archivedDocs.length,
            document_ids: docIds,
          },
          "pending approved by matching to awaiting payment",
        );

        return {
          pending_id: row.id,
          transaction_id: transactionId,
          matched_awaiting_id: req.body.match_id,
          action: "match",
          document_path: primary?.document_path ?? null,
          documents: archivedDocs.map(serializeArchivedDoc),
        };
      }

      // ─── Branch 3: default — straight to GL (current behavior) ────────────
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
          action: "to_gl",
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
        action: "to_gl",
        document_path: primary?.document_path ?? null,
        documents: archivedDocs.map(serializeArchivedDoc),
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/awaiting — list AwaitingPayment rows.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get(
    "/api/awaiting",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["awaiting", "paid", "written_off", "rejected", "all"],
              default: "awaiting",
            },
            vendor: { type: "string" },
          },
        },
      },
    },
    async (req) => {
      let entries = await listAwaiting({ status: req.query.status });
      if (req.query.vendor) {
        entries = entries.filter((r) => r.vendor === req.query.vendor);
      }
      return { count: entries.length, entries };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/awaiting/:id — single AwaitingPayment row.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get("/api/awaiting/:id", async (req, reply) => {
    const row = await getAwaiting(req.params.id);
    if (!row) return reply.code(404).send({ error: "AwaitingPayment row not found" });
    return row;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/awaiting/:id/pay — record a manual payment against an
  // outstanding invoice when there's no receipt to parse (check from your
  // bank, credit-card charge with no vendor receipt, etc). Books a GL row
  // using the AwaitingPayment row's vendor/amount + the user-supplied
  // payment date/source/category, marks the awaiting row paid, and
  // re-attaches any archived invoice docs to the new transaction.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post(
    "/api/awaiting/:id/pay",
    {
      schema: {
        body: {
          type: "object",
          required: ["date", "category", "payment_source"],
          additionalProperties: false,
          properties: {
            date: { type: "string" }, // YYYY-MM-DD, payment date
            category: { type: "string", minLength: 1 },
            payment_source: { type: "string", minLength: 1 },
            reference_number: { type: ["string", "null"], default: null },
            reference_kind: {
              type: ["string", "null"],
              enum: [
                "invoice",
                "receipt",
                "order",
                "transaction",
                "confirmation",
                "other",
                null,
              ],
              default: "confirmation",
            },
            description: { type: "string", default: "" },
            notes: { type: "string", default: "" },
          },
        },
      },
    },
    async (req, reply) => {
      const awaiting = await getAwaiting(req.params.id);
      if (!awaiting) {
        return reply.code(404).send({ error: "AwaitingPayment row not found" });
      }
      if (awaiting.status !== "awaiting") {
        return reply
          .code(409)
          .send({ error: `Cannot pay an AwaitingPayment with status=${awaiting.status}` });
      }

      // Register the payment source in the Sources sheet on first use so
      // future Record-payment forms have it in the dropdown. ensurePaymentSource
      // returns the canonical spelling if the user re-used an existing one
      // (case-insensitive), keeping the GL consistent.
      const { name: canonicalSource, added: sourceAdded } =
        await ensurePaymentSource(req.body.payment_source);

      const { id: transactionId } = await addTransaction({
        vendor: awaiting.vendor,
        date: req.body.date,
        amount: awaiting.amount,
        currency: awaiting.currency ?? "USD",
        category: req.body.category,
        payment_source: canonicalSource || req.body.payment_source,
        reference_number: req.body.reference_number ?? null,
        reference_kind: req.body.reference_kind ?? "confirmation",
        document_path: awaiting.document_path ?? null,
        description: req.body.description ?? "",
        notes: req.body.notes ?? "",
        source_file: null,
        pending_id: null,
        created_by: "user",
      });

      // Carry the invoice's Documents rows forward to the new txn so the
      // GL→Documents link is intact. (No new docs to add — there's no
      // source receipt for this payment.)
      await attachDocumentsToTransaction({
        awaiting_id: req.params.id,
        txn_id: transactionId,
      });

      await markAwaitingPaid(req.params.id, { paid_txn_id: transactionId });

      req.log.info(
        {
          awaiting_id: req.params.id,
          transaction_id: transactionId,
          action: "manual_pay",
          vendor: awaiting.vendor,
          amount: awaiting.amount,
          payment_source: canonicalSource || req.body.payment_source,
          payment_source_added: sourceAdded,
          reference_number: req.body.reference_number ?? null,
        },
        "manual payment recorded",
      );

      return {
        awaiting_id: req.params.id,
        transaction_id: transactionId,
        action: "manual_pay",
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
  // GET /api/documents/by-id/:doc_id — stream an archived document by its
  // Documents-sheet ID. Used by the dashboard file browser, which deals in
  // doc IDs rather than txn IDs (a single txn can have multiple docs).
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get("/api/documents/by-id/:doc_id", async (req, reply) => {
    const doc = await getDocument(req.params.doc_id);
    if (!doc) return reply.code(404).send({ error: "Document not found" });
    if (!doc.document_path) {
      return reply.code(404).send({ error: "Document has no archived path" });
    }
    const absolute = resolveDocumentPath({
      companyId: COMPANY_ID,
      documentPath: doc.document_path,
    });
    if (!absolute) return reply.code(400).send({ error: "Invalid document path" });

    try {
      const buffer = await fs.readFile(absolute);
      const ext = path.extname(absolute).slice(1).toLowerCase();
      const mime = MIME_BY_EXT[ext] || "application/octet-stream";
      reply
        .header("Content-Type", mime)
        .header(
          "Content-Disposition",
          `inline; filename="${path.basename(absolute)}"`,
        )
        .send(buffer);
    } catch {
      return reply.code(404).send({ error: "Document file missing on disk" });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/files/ledger — download the active company's ledger workbook.
  // The file lives outside the documents/ tree so it gets its own route.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get("/api/files/ledger", async (req, reply) => {
    const ledgerPath = getLedgerPath();
    try {
      const buffer = await fs.readFile(ledgerPath);
      reply
        .header(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .header(
          "Content-Disposition",
          `attachment; filename="${path.basename(ledgerPath)}"`,
        )
        .send(buffer);
    } catch (err) {
      req.log.error({ err: err.message, ledgerPath }, "ledger read failed");
      return reply.code(404).send({ error: "Ledger workbook not found" });
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
  // POST /api/pending/:id/reparse — re-run the parser on the saved payload,
  // overwrite the existing PendingInbox row's data fields, and write a
  // fresh -parsed.json sidecar. Useful when an entry was parsed before
  // some parser improvement (e.g. reference_number extraction) and the
  // pending row is missing fields.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post("/api/pending/:id/reparse", async (req, reply) => {
    const row = await getPending(req.params.id);
    if (!row) return reply.code(404).send({ error: "Pending entry not found" });
    if (row.status !== "pending") {
      return reply.code(409).send({ error: `Cannot reparse a ${row.status} entry` });
    }
    if (!row.source_file) {
      return reply.code(400).send({ error: "No source_file recorded for this row" });
    }

    const payloadPath = path.join(logDir, row.source_file);
    let payload;
    try {
      payload = JSON.parse(await fs.readFile(payloadPath, "utf-8"));
    } catch {
      return reply.code(404).send({ error: "Source payload missing or unreadable" });
    }

    let result;
    try {
      const [categories, paymentSources, knownVendors] = await Promise.all([
        getCategories().catch(() => []),
        getPaymentSources().catch(() => []),
        getKnownVendors().catch(() => []),
      ]);
      result = await parseReceipt(payload, {
        categories,
        paymentSources,
        knownVendors,
      });
    } catch (err) {
      return reply.code(500).send({ error: `Parser failed: ${err.message}` });
    }

    // Fresh sidecar overwrites the prior one.
    const parsedPath = path.join(
      logDir,
      row.source_file.replace(/\.json$/, "-parsed.json"),
    );
    await fs
      .writeFile(parsedPath, JSON.stringify(result, null, 2))
      .catch((err) => req.log.error({ err }, "failed to write reparsed sidecar"));

    // Update existing pending row in place — keeps id, status, source_file
    // intact so the UI/links stay valid.
    try {
      await updatePendingFromParse(row.id, result);
    } catch (err) {
      return reply.code(500).send({ error: `Failed to update pending row: ${err.message}` });
    }

    req.log.info(
      {
        pending_id: row.id,
        status: result.status,
        reference_kind: result.proposal?.reference_number?.kind ?? null,
        reference_number: result.proposal?.reference_number?.value ?? null,
        vendor: result.proposal?.vendor?.name ?? null,
        total: result.proposal?.total?.amount ?? null,
        usage: result.usage,
      },
      "pending reparsed",
    );

    return {
      pending_id: row.id,
      status: result.status,
      reason: result.reason,
      proposal: result.proposal,
      usage: result.usage,
    };
  });

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

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/main-timeline — the global, all-vendor timeline used as the
  // dashboard's home screen on login. Returns the same payload shape that
  // the agent tool show_main_timeline emits, so the frontend can render
  // it via the existing VendorTimelinePanel.vue component.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get(
    "/api/main-timeline",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            from: { type: "string" },
            to: { type: "string" },
          },
        },
      },
    },
    async (req) => {
      const props = await buildTimelineProps({
        vendor: null,
        from: req.query.from,
        to: req.query.to,
      });
      return {
        kind: "vendor_timeline",
        title: "All activity",
        props,
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/agent/chat — bookkeeping agent (Sonnet 4.6 + read-only tools),
  // streamed back as Server-Sent Events. Each event line is:
  //   data: {"type":"text_delta","text":"..."}
  //
  // Event types emitted: text_delta, tool_use, tool_result, usage, done, error.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post(
    "/api/agent/chat",
    {
      schema: {
        body: {
          type: "object",
          required: ["messages"],
          additionalProperties: false,
          properties: {
            messages: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["role", "content"],
                additionalProperties: false,
                properties: {
                  role: { type: "string", enum: ["user", "assistant"] },
                  // string or content-block array — SDK validates the shape
                  content: {},
                },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const started = Date.now();
      req.log.info(
        { msg_count: req.body.messages.length },
        "agent chat started",
      );

      // Hijack so we own the response lifecycle end-to-end. Two reasons:
      //
      // 1) CORS — we set Access-Control-Allow-Origin manually here
      //    (mirroring what @fastify/cors's onSend hook would have set on a
      //    normal response), because hijacking bypasses that hook.
      // 2) Connection: close — using keep-alive with this streamed response
      //    leaves the connection in a state where the next browser request
      //    intermittently fails (NetworkError on alternating attempts).
      //    Closing per-request adds ~one TLS handshake; well worth the
      //    reliability.
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        ...corsHeadersFor(req.headers.origin),
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "close",
        "X-Accel-Buffering": "no", // disable nginx proxy buffering
      });

      const send = (event) => {
        if (res.writableEnded) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      // If the client disconnects mid-stream we still want to drain the
      // agent loop's logging in `finally`, but stop writing.
      req.raw.on("close", () => {
        if (!res.writableEnded) res.end();
      });

      try {
        for await (const event of runAgent({
          messages: req.body.messages,
          logger: req.log,
          companyName: COMPANY_NAME,
        })) {
          send(event);
        }
      } catch (err) {
        req.log.error(
          { err: err.message, stack: err.stack },
          "agent loop failed",
        );
        send({ type: "error", error: err.message });
      } finally {
        req.log.info(
          { duration_ms: Date.now() - started },
          "agent chat finished",
        );
        if (!res.writableEnded) res.end();
      }
    },
  );
}
