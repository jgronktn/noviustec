// Read payment sources from the ledger.

import { SHEETS } from "./schema.js";
import { withWorkbookRead, readRows } from "./workbook.js";

export async function getPaymentSources({ activeOnly = true } = {}) {
  return withWorkbookRead(async (wb) => {
    const sheet = wb.getWorksheet(SHEETS.SOURCES);
    const rows = readRows(sheet);
    return activeOnly ? rows.filter((r) => r.active === true || r.active === "TRUE" || r.active === 1) : rows;
  });
}
