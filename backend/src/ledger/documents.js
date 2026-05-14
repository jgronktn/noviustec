// Documents sheet operations.
//
// One row per archived file. A single GL transaction can have multiple
// document rows (e.g., Anthropic emails both an Invoice and a Receipt for
// the same charge — both worth tracking even though only one $50 line
// goes into the GL).

import { randomUUID } from "node:crypto";
import { SHEETS } from "./schema.js";
import { withWorkbookRead, withWorkbookWrite, readRows } from "./workbook.js";

const DOC_ID_PREFIX = "doc_";

/**
 * Append a document row.
 *
 * @param {object} params
 * @param {string}   params.vendor
 * @param {Date|string} params.date          - JS Date or ISO YYYY-MM-DD
 * @param {string|null} params.reference_kind
 * @param {string|null} params.reference_number
 * @param {string}   params.filename         - our canonical name on disk
 * @param {string}   params.original_filename - what the source called it
 * @param {string}   params.document_path    - relative to company root
 * @param {string|null} params.txn_id        - GL FK (null if doc not tied to a txn)
 * @param {string|null} params.pending_id    - PendingInbox FK
 */
export async function addDocument(params) {
  const id = DOC_ID_PREFIX + randomUUID().slice(0, 8);
  const row = {
    id,
    vendor: params.vendor ?? null,
    date:
      typeof params.date === "string"
        ? new Date(params.date + "T00:00:00Z")
        : (params.date ?? null),
    reference_kind: params.reference_kind ?? null,
    reference_number: params.reference_number ?? null,
    filename: params.filename,
    original_filename: params.original_filename ?? null,
    document_path: params.document_path,
    txn_id: params.txn_id ?? null,
    pending_id: params.pending_id ?? null,
    created_at: new Date().toISOString(),
  };
  await withWorkbookWrite(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.DOCUMENTS);
    sheet.addRow(row);
  });
  return { id, row };
}

export async function listDocuments({ txn_id, pending_id } = {}) {
  return withWorkbookRead(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.DOCUMENTS);
    let rows = readRows(sheet);
    if (txn_id) rows = rows.filter((r) => r.txn_id === txn_id);
    if (pending_id) rows = rows.filter((r) => r.pending_id === pending_id);
    return rows;
  });
}

export async function getDocument(id) {
  const all = await listDocuments();
  return all.find((r) => r.id === id) ?? null;
}
