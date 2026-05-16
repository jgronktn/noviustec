// Native Anthropic tool definitions for the bookkeeping agent.
//
// All read-only for Slice 1. The last entry carries cache_control: ephemeral
// so the entire tools block participates in the prompt-cache breakpoint.
// Render order is tools → system → messages — caching the tail of tools is
// enough to cache the whole tools section.

export const TOOL_DEFINITIONS = [
  {
    name: "list_pending",
    description:
      "List receipt entries that have arrived (via email or upload) and are sitting in the inbox awaiting user review. These are NOT yet in the books. Default returns status=pending.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "approved", "rejected", "all"],
          description: "Filter by review status. Default: pending.",
        },
      },
    },
  },
  {
    name: "list_transactions",
    description:
      "List rows from the General Ledger (approved expenses). Cash-basis: each row represents money that has moved. Filter by date range, category, or payment source.",
    input_schema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "Inclusive start date in YYYY-MM-DD format.",
        },
        to: {
          type: "string",
          description: "Inclusive end date in YYYY-MM-DD format.",
        },
        category: {
          type: "string",
          description: "Filter to a single expense category (exact match).",
        },
        payment_source: {
          type: "string",
          description:
            "Filter to a single payment source — credit card, bank, etc.",
        },
      },
    },
  },
  {
    name: "list_awaiting_payment",
    description:
      "List invoices that have been received but NOT yet paid. These are not yet expenses (cash-basis) — they become GL transactions when the receipt arrives and the user matches them. Default returns status=awaiting (still outstanding).",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["awaiting", "paid", "all"],
          description: "Default: awaiting (still outstanding).",
        },
        vendor: {
          type: "string",
          description: "Filter to a single vendor (exact match).",
        },
      },
    },
  },
  {
    name: "get_pnl",
    description:
      "Get a profit-and-loss summary for a date range. Returns total expense, total transaction count, and per-category breakdown sorted by total descending. Use this for 'how much did we spend' or 'spend by category' questions instead of paginating list_transactions.",
    input_schema: {
      type: "object",
      required: ["from", "to"],
      properties: {
        from: {
          type: "string",
          description: "Inclusive start date in YYYY-MM-DD format.",
        },
        to: {
          type: "string",
          description: "Inclusive end date in YYYY-MM-DD format.",
        },
      },
    },
  },
  {
    name: "get_categories",
    description:
      "List the active chart of accounts (expense categories). Use when the user asks what categories exist or you need to validate a category name.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_payment_sources",
    description:
      "List active payment sources (credit cards, bank accounts). Use when the user asks what sources exist or wants to filter by source.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_documents",
    description:
      "List archived source documents (invoice PDFs, receipt images) attached to a specific transaction or pending entry. Returns metadata only — vendor, date, reference number, filename. The agent cannot read the file contents directly.",
    input_schema: {
      type: "object",
      properties: {
        txn_id: {
          type: "string",
          description: "Filter to documents attached to a GL transaction id.",
        },
        pending_id: {
          type: "string",
          description: "Filter to documents archived for a pending entry id.",
        },
      },
    },
  },

  // ── Render tools ──────────────────────────────────────────────────────────
  // These push a typed panel into the dashboard canvas AND return a small
  // summary to the model. Use them when the user wants to *see* something
  // (charts, tables, headline numbers) — not when they just want a one-line
  // text answer. Don't pair them with the corresponding data tool for the
  // same query; the render tools already fetch the underlying data.

  {
    name: "show_pnl_chart",
    description:
      "Render a P&L breakdown as a horizontal bar chart in the dashboard. Use when the user asks to 'see' or 'show' spend by category for a date range, or wants to compare 4+ categories visually. For a quick text answer about totals, use get_pnl instead.",
    input_schema: {
      type: "object",
      required: ["from", "to"],
      properties: {
        from: {
          type: "string",
          description: "Inclusive start date in YYYY-MM-DD format.",
        },
        to: {
          type: "string",
          description: "Inclusive end date in YYYY-MM-DD format.",
        },
        title: {
          type: "string",
          description:
            "Optional title for the panel (e.g. 'P&L — YTD 2026'). Defaults to a date-range string.",
        },
      },
    },
  },
  {
    name: "show_transaction_table",
    description:
      "Render a table of GL transactions in the dashboard. Use when the user wants to inspect individual rows for a date range, category, vendor, or payment source. Caps at 100 rows.",
    input_schema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "Inclusive start date in YYYY-MM-DD format.",
        },
        to: {
          type: "string",
          description: "Inclusive end date in YYYY-MM-DD format.",
        },
        category: {
          type: "string",
          description: "Filter to a single category (exact match).",
        },
        payment_source: {
          type: "string",
          description: "Filter to a single payment source (exact match).",
        },
        vendor: {
          type: "string",
          description: "Filter to a single vendor (exact match).",
        },
        title: {
          type: "string",
          description: "Optional title. Defaults to a filter-description string.",
        },
      },
    },
  },
  {
    name: "show_awaiting_table",
    description:
      "Render a table of outstanding (unpaid) invoices in the dashboard. Use when the user wants to see what's owed.",
    input_schema: {
      type: "object",
      properties: {
        vendor: {
          type: "string",
          description: "Filter to a single vendor (exact match).",
        },
        title: {
          type: "string",
          description: "Optional title.",
        },
      },
    },
  },
  {
    name: "show_main_timeline",
    description:
      "Render the global activity timeline — every invoice, receipt and payment across every vendor — in the same two-column timeline format as show_vendor_timeline. Use when the user wants the unfiltered, all-vendor view (the default dashboard home screen). Each card shows the vendor name since the view is multi-vendor.",
    input_schema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "Optional inclusive start date (YYYY-MM-DD).",
        },
        to: {
          type: "string",
          description: "Optional inclusive end date (YYYY-MM-DD).",
        },
        title: {
          type: "string",
          description: "Optional title.",
        },
      },
    },
  },
  {
    name: "show_vendor_timeline",
    description:
      "Render a two-column vertical timeline for a single vendor — invoices on the left, payments on the right, sorted chronologically. Each event is a card anchored by its date, with subtle color coding (gray = paid, amber = awaiting, red = overdue). A running balance + outstanding-invoice list sits at the top. Use this when the user wants to see the financial relationship with one vendor over time: 'show my Anthropic timeline', 'history with Kroger', 'what's our DigitalOcean relationship look like'. Vendor match is case-insensitive substring.",
    input_schema: {
      type: "object",
      required: ["vendor"],
      properties: {
        vendor: {
          type: "string",
          description:
            "Vendor query. Matches stored vendor names by case-insensitive substring — 'anthropic' matches 'Anthropic, PBC'.",
        },
        from: {
          type: "string",
          description: "Optional inclusive start date (YYYY-MM-DD).",
        },
        to: {
          type: "string",
          description: "Optional inclusive end date (YYYY-MM-DD).",
        },
        title: {
          type: "string",
          description: "Optional title.",
        },
      },
    },
  },
  {
    name: "show_file_list",
    description:
      "Render a downloadable list of archived files in the dashboard (PDFs and images attached to receipts, invoices, etc., plus the ledger workbook itself). The panel lets the user download individual files or select multiple and download them in bulk. Filter by reference_kind (invoice, receipt, order, transaction, confirmation, other), or use kind='ledger' to surface just the ledger workbook, or omit kind to include everything.",
    input_schema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [
            "invoice",
            "receipt",
            "order",
            "transaction",
            "confirmation",
            "other",
            "ledger",
            "all",
          ],
          description:
            "Filter to a document kind, or 'ledger' for the workbook only, or 'all' (default) to include the ledger plus every document.",
        },
        vendor: {
          type: "string",
          description: "Filter to a single vendor (exact match).",
        },
        from: {
          type: "string",
          description: "Inclusive start date in YYYY-MM-DD format.",
        },
        to: {
          type: "string",
          description: "Inclusive end date in YYYY-MM-DD format.",
        },
        limit: {
          type: "integer",
          description: "Cap to most recent N documents. Default 100.",
        },
        title: {
          type: "string",
          description: "Optional title.",
        },
      },
    },
  },
  {
    name: "show_statements_list",
    description:
      "Render a table of imported bank and credit-card statements (from the Statements sheet — NOT the document archive). Each row shows the statement's source account, period, line count, opening/closing balances, and totals, with a Download button to grab the original PDF. Use this when the user asks to see bank statements, credit-card statements, or 'statements I uploaded'. Filter by status or by source.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["all", "imported", "needs_attention", "reconciled", "partially_reconciled"],
          description: "Filter by status. Default: all.",
        },
        source: {
          type: "string",
          description: "Filter to a single payment source name (exact match).",
        },
        title: {
          type: "string",
          description: "Optional title.",
        },
      },
    },
  },
  {
    name: "show_inbox_list",
    description:
      "Render a table of all items received in the inbox (receipts that arrived via email or upload). Shows pending, approved, and rejected entries together so the user can see the full history of what's come in. Default returns all statuses, newest first. Cap at 100 rows.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "approved", "rejected", "all"],
          description: "Filter by status. Default: all.",
        },
        limit: {
          type: "integer",
          description: "Cap to most recent N entries. Default: 100.",
        },
        title: {
          type: "string",
          description: "Optional title.",
        },
      },
    },
  },
  {
    name: "show_vendor_breakdown",
    description:
      "Render a per-vendor spend breakdown as a horizontal bar list in the dashboard. Use when the user asks to 'see' / 'list' / 'show' vendors, who they're spending the most with, or wants a vendor leaderboard. Cash-basis: only counts approved GL transactions.",
    input_schema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "Inclusive start date in YYYY-MM-DD format. Omit for all-time.",
        },
        to: {
          type: "string",
          description: "Inclusive end date in YYYY-MM-DD format. Omit for all-time.",
        },
        category: {
          type: "string",
          description: "Filter to vendors used within a single category (exact match).",
        },
        limit: {
          type: "integer",
          description: "Cap to top N vendors by total spend. Defaults to all vendors (capped at 50).",
        },
        title: {
          type: "string",
          description: "Optional title.",
        },
      },
    },
  },
  {
    name: "show_kpi_summary",
    description:
      "Render a headline KPI tile grid in the dashboard (pending count, YTD spend, outstanding total, recent transaction count). Use when the user asks for an overview / 'how are we doing' / 'state of the books'. Always queries the current state — does not take a date range.",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Optional title.",
        },
      },
    },
    cache_control: { type: "ephemeral" },
  },
];
