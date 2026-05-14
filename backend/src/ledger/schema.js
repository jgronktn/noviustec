// Workbook schema: sheets, columns, and default category seeds.
//
// Conventions:
// - Every sheet has a stable column order keyed by `key` (used by exceljs to
//   add/read rows by object).
// - Column types are enforced when reading back (see workbook.js / pending.js).
// - Header row gets bold + light-gray formatting (set in workbook.js).

export const SHEETS = {
  CATEGORIES: "Categories",
  SOURCES: "Sources",
  PENDING: "PendingInbox",
  GL: "GL",
  DOCUMENTS: "Documents",
};

export const COLUMNS = {
  [SHEETS.CATEGORIES]: [
    { header: "Name", key: "name", width: 32 },
    { header: "Type", key: "type", width: 12 }, // "expense" | "revenue" | "transfer"
    { header: "Description", key: "description", width: 50 },
    { header: "Account_Code", key: "account_code", width: 14 },
    { header: "Active", key: "active", width: 8 },
  ],
  [SHEETS.SOURCES]: [
    { header: "Name", key: "name", width: 32 },
    { header: "Type", key: "type", width: 16 }, // "credit_card" | "bank_account" | "cash" | "other"
    { header: "Last4", key: "last4", width: 8 },
    { header: "Institution", key: "institution", width: 24 },
    { header: "Description", key: "description", width: 40 },
    { header: "Active", key: "active", width: 8 },
  ],
  [SHEETS.PENDING]: [
    { header: "ID", key: "id", width: 16 },
    { header: "Status", key: "status", width: 12 }, // "pending" | "approved" | "rejected"
    { header: "Received_At", key: "received_at", width: 22 },
    { header: "Source_File", key: "source_file", width: 50 },
    { header: "Vendor", key: "vendor", width: 28 },
    { header: "Date", key: "date", width: 12, style: { numFmt: "yyyy-mm-dd" } },
    { header: "Total", key: "total", width: 12, style: { numFmt: '#,##0.00' } },
    { header: "Currency", key: "currency", width: 8 },
    { header: "Reference_Number", key: "reference_number", width: 22 },
    { header: "Reference_Kind", key: "reference_kind", width: 14 }, // invoice|receipt|order|transaction|confirmation|other
    { header: "Suggested_Category", key: "suggested_category", width: 28 },
    { header: "Suggested_Source", key: "suggested_source", width: 28 },
    { header: "Confidence", key: "confidence", width: 10, style: { numFmt: "0.00" } },
    { header: "Reason", key: "reason", width: 24 },
    { header: "Resolved_At", key: "resolved_at", width: 22 },
    { header: "Resolution_Notes", key: "resolution_notes", width: 40 },
  ],
  [SHEETS.GL]: [
    { header: "ID", key: "id", width: 16 },
    { header: "Date", key: "date", width: 12, style: { numFmt: "yyyy-mm-dd" } },
    { header: "Vendor", key: "vendor", width: 28 },
    { header: "Description", key: "description", width: 40 },
    { header: "Category", key: "category", width: 28 },
    { header: "Payment_Source", key: "payment_source", width: 28 },
    { header: "Amount", key: "amount", width: 12, style: { numFmt: '#,##0.00' } },
    { header: "Currency", key: "currency", width: 8 },
    { header: "Reference_Number", key: "reference_number", width: 22 },
    { header: "Reference_Kind", key: "reference_kind", width: 14 },
    { header: "Document_Path", key: "document_path", width: 60 }, // primary doc; full list in Documents sheet
    { header: "Notes", key: "notes", width: 50 },
    { header: "Source_File", key: "source_file", width: 50 },
    { header: "Pending_ID", key: "pending_id", width: 16 },
    { header: "Created_At", key: "created_at", width: 22 },
    { header: "Created_By", key: "created_by", width: 12 }, // "user" | "agent"
  ],
  [SHEETS.DOCUMENTS]: [
    { header: "ID", key: "id", width: 16 },
    { header: "Vendor", key: "vendor", width: 28 },
    { header: "Date", key: "date", width: 12, style: { numFmt: "yyyy-mm-dd" } },
    { header: "Reference_Kind", key: "reference_kind", width: 14 },
    { header: "Reference_Number", key: "reference_number", width: 22 },
    { header: "Filename", key: "filename", width: 50 },
    { header: "Original_Filename", key: "original_filename", width: 50 },
    { header: "Document_Path", key: "document_path", width: 60 },
    { header: "TXN_ID", key: "txn_id", width: 16 },
    { header: "Pending_ID", key: "pending_id", width: 16 },
    { header: "Created_At", key: "created_at", width: 22 },
  ],
};

// Seed categories written on first workbook creation. Users edit these
// directly in Excel after that — the ledger is the source of truth, not this
// file. To re-seed an existing ledger, delete the Categories sheet rows or
// blow away the file with `npm run init-ledger`.
export const DEFAULT_CATEGORIES = [
  { name: "Software & Subscriptions", type: "expense", description: "SaaS tools, cloud services, dev tools", account_code: "", active: true },
  { name: "Office Supplies", type: "expense", description: "", account_code: "", active: true },
  { name: "Travel - Flights", type: "expense", description: "", account_code: "", active: true },
  { name: "Travel - Hotels", type: "expense", description: "", account_code: "", active: true },
  { name: "Travel - Meals", type: "expense", description: "", account_code: "", active: true },
  { name: "Travel - Ground Transport", type: "expense", description: "Uber, Lyft, taxis, rental cars", account_code: "", active: true },
  { name: "Meals & Entertainment", type: "expense", description: "Business meals, client entertainment (local)", account_code: "", active: true },
  { name: "Professional Services", type: "expense", description: "Legal, accounting, consulting", account_code: "", active: true },
  { name: "Hardware & Equipment", type: "expense", description: "", account_code: "", active: true },
  { name: "Marketing & Advertising", type: "expense", description: "", account_code: "", active: true },
  { name: "Postage & Shipping", type: "expense", description: "", account_code: "", active: true },
  { name: "Utilities", type: "expense", description: "", account_code: "", active: true },
  { name: "Bank Fees", type: "expense", description: "", account_code: "", active: true },
  { name: "Other / Uncategorized", type: "expense", description: "", account_code: "", active: true },
];

// Payment sources are NOT auto-seeded — too user-specific. Users add via Excel
// (or, eventually, a UI). Empty seed avoids steering the parser toward
// fabricated source names.
export const DEFAULT_PAYMENT_SOURCES = [];
