// Read categories from the ledger.
// CRUD beyond reads is "edit the Excel file directly" for v1.

import { SHEETS } from "./schema.js";
import { withWorkbookRead, readRows } from "./workbook.js";

export async function getCategories({ activeOnly = true } = {}) {
  return withWorkbookRead(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.CATEGORIES);
    const rows = readRows(sheet);
    return activeOnly ? rows.filter((r) => r.active === true || r.active === "TRUE" || r.active === 1) : rows;
  });
}
