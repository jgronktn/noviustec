// GL (General Ledger) operations.
//
// addTransaction(): writes an approved transaction. Called from the approval
//   flow when the user accepts a pending row (with any adjustments).
// listTransactions(): for reporting / agent tool surface later.

import { randomUUID } from "node:crypto";
import { SHEETS } from "./schema.js";
import { withWorkbookRead, withWorkbookWrite, readRows } from "./workbook.js";

const TXN_ID_PREFIX = "txn_";

/**
 * Append a transaction to the GL.
 *
 * @param {object} params
 * @param {string} params.vendor
 * @param {Date|string} params.date - JS Date or ISO YYYY-MM-DD
 * @param {string} params.category
 * @param {string} [params.payment_source]
 * @param {number} params.amount
 * @param {string} [params.currency] - defaults to "USD"
 * @param {string} [params.description]
 * @param {string} [params.notes]
 * @param {string} [params.source_file] - filename of the original Postmark payload
 * @param {string} [params.pending_id] - source PendingInbox row id (for traceability)
 * @param {"user"|"agent"} [params.created_by]
 */
export async function addTransaction(params) {
  const id = TXN_ID_PREFIX + randomUUID().slice(0, 8);
  const row = {
    id,
    date: typeof params.date === "string" ? new Date(params.date + "T00:00:00Z") : params.date,
    vendor: params.vendor,
    description: params.description ?? "",
    category: params.category,
    payment_source: params.payment_source ?? null,
    amount: params.amount,
    currency: params.currency ?? "USD",
    notes: params.notes ?? "",
    source_file: params.source_file ?? null,
    pending_id: params.pending_id ?? null,
    created_at: new Date().toISOString(),
    created_by: params.created_by ?? "user",
  };
  await withWorkbookWrite(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.GL);
    sheet.addRow(row);
  });
  return { id, row };
}

export async function listTransactions({ from, to, category, payment_source } = {}) {
  return withWorkbookRead(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.GL);
    let rows = readRows(sheet);
    if (from) rows = rows.filter((r) => r.date && new Date(r.date) >= new Date(from));
    if (to) rows = rows.filter((r) => r.date && new Date(r.date) <= new Date(to));
    if (category) rows = rows.filter((r) => r.category === category);
    if (payment_source) rows = rows.filter((r) => r.payment_source === payment_source);
    return rows;
  });
}
