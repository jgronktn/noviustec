// Tool dispatcher for the bookkeeping agent.
//
// Maps Anthropic tool_use names to the existing ledger read functions, with
// light post-processing (date → ISO string, group-by for P&L, scrub
// filesystem paths). Returns plain JSON-serializable objects.

import * as path from "node:path";
import {
  listPending,
  listTransactions,
  listAwaiting,
  getCategories,
  getPaymentSources,
  listDocuments,
  listStatements,
  listStatementLines,
  getLedgerPath,
} from "../ledger/index.js";
import {
  autoMatchStatement,
  buildReconciliationView,
  findStatementBySource,
} from "../reconciliation/index.js";

function isoDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string") {
    // dates already in YYYY-MM-DD pass through; ISO strings get truncated
    return v.length >= 10 ? v.slice(0, 10) : v;
  }
  return null;
}

function scrubTransaction(r) {
  return {
    id: r.id,
    date: isoDate(r.date),
    vendor: r.vendor,
    description: r.description ?? "",
    category: r.category,
    payment_source: r.payment_source ?? null,
    amount: r.amount,
    currency: r.currency ?? "USD",
    reference_number: r.reference_number ?? null,
    reference_kind: r.reference_kind ?? null,
    notes: r.notes ?? "",
  };
}

function scrubAwaiting(r) {
  return {
    id: r.id,
    status: r.status,
    vendor: r.vendor,
    date: isoDate(r.date),
    amount: r.amount,
    currency: r.currency ?? "USD",
    reference_number: r.reference_number ?? null,
    reference_kind: r.reference_kind ?? null,
    description: r.description ?? "",
    paid_at: r.paid_at ?? null,
    paid_txn_id: r.paid_txn_id ?? null,
  };
}

function scrubPending(r) {
  return {
    id: r.id,
    status: r.status,
    vendor: r.vendor,
    date: isoDate(r.date),
    total: r.total,
    currency: r.currency ?? "USD",
    suggested_category: r.suggested_category ?? null,
    confidence: r.confidence ?? null,
    reference_number: r.reference_number ?? null,
    reference_kind: r.reference_kind ?? null,
    reason: r.reason ?? null,
  };
}

function scrubDocument(r) {
  return {
    id: r.id,
    vendor: r.vendor,
    date: isoDate(r.date),
    reference_kind: r.reference_kind ?? null,
    reference_number: r.reference_number ?? null,
    filename: r.filename,
    original_filename: r.original_filename ?? null,
    txn_id: r.txn_id ?? null,
    pending_id: r.pending_id ?? null,
    awaiting_id: r.awaiting_id ?? null,
  };
}

async function computePnl({ from, to }) {
  if (!from || !to) {
    throw new Error("get_pnl requires both 'from' and 'to' (YYYY-MM-DD)");
  }
  const rows = await listTransactions({ from, to });
  const buckets = new Map();
  let totalExpense = 0;
  for (const r of rows) {
    const cat = r.category || "(uncategorized)";
    const amount = Number(r.amount) || 0;
    totalExpense += amount;
    const b = buckets.get(cat) ?? { category: cat, total: 0, count: 0 };
    b.total += amount;
    b.count += 1;
    buckets.set(cat, b);
  }
  const totals_by_category = [...buckets.values()]
    .map((b) => ({ ...b, total: Math.round(b.total * 100) / 100 }))
    .sort((a, b) => b.total - a.total);
  return {
    period: { from, to },
    count: rows.length, // mirrors total_count so the UI pill shows N transactions
    total_count: rows.length,
    total_expense: Math.round(totalExpense * 100) / 100,
    totals_by_category,
  };
}

// Case-insensitive substring vendor match. Lets the user say "Anthropic"
// and find rows stored as "Anthropic, PBC", or "kroger" → "Kroger". Used
// by every show_* tool that takes a vendor filter — exact-match was a
// footgun whenever a vendor's stored name had extra suffixes or commas.
function vendorMatches(rowVendor, query) {
  if (!query) return true;
  if (!rowVendor) return false;
  return rowVendor.toLowerCase().includes(query.toLowerCase());
}

function describeFilters({ from, to, category, payment_source, vendor }) {
  const parts = [];
  if (from && to) parts.push(`${from} – ${to}`);
  else if (from) parts.push(`from ${from}`);
  else if (to) parts.push(`through ${to}`);
  if (category) parts.push(`category=${category}`);
  if (payment_source) parts.push(`source=${payment_source}`);
  if (vendor) parts.push(`vendor=${vendor}`);
  return parts.join(" · ");
}

function daysBetween(a, b) {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

const TXN_TABLE_LIMIT = 100;

const TIMELINE_OVERDUE_DAYS = 30;

/**
 * Build the timeline panel payload. Used by:
 *  - show_vendor_timeline (agent tool, vendor required)
 *  - show_main_timeline   (agent tool, vendor null — all vendors)
 *  - GET /api/main-timeline (direct HTTP route for the dashboard home screen)
 *
 * When `vendor` is null/empty, every vendor's events appear and the panel
 * renders in "global mode" (vendor name shown on each card).
 */
export async function buildTimelineProps({ vendor = null, from, to } = {}) {
  const today = new Date().toISOString().slice(0, 10);

  const awaitingAll = await listAwaiting({ status: "all" });
  const txnAll = await listTransactions({ from, to });
  // Pre-fetch every Documents row so the timeline can render one left-side
  // card per archived doc instead of just one per GL row. Anthropic emails
  // ship an invoice PDF and a receipt PDF together — both belong on the
  // timeline as separate events tied to the same payment.
  const docsAll = await listDocuments();
  // Group docs by their GL transaction id. Skip docs that are ALSO tied to
  // an AwaitingPayment row: those already get a left card from the awaiting
  // side (drawn on the invoice's date, not the payment date), and we don't
  // want to double-show the same doc on the GL date too.
  const docsByTxn = new Map();
  for (const d of docsAll) {
    if (!d.txn_id) continue;
    if (d.awaiting_id) continue;
    if (!d.reference_kind) continue;
    if (!docsByTxn.has(d.txn_id)) docsByTxn.set(d.txn_id, []);
    docsByTxn.get(d.txn_id).push(d);
  }

  const matchedAwaiting = vendor
    ? awaitingAll.filter((r) => vendorMatches(r.vendor, vendor))
    : awaitingAll;
  const matchedTxns = vendor
    ? txnAll.filter((r) => vendorMatches(r.vendor, vendor))
    : txnAll;

  const inRange = (d) => {
    const iso = isoDate(d);
    if (!iso) return false;
    if (from && iso < from) return false;
    if (to && iso > to) return false;
    return true;
  };

  // Left-side events (document side: invoices and receipts).
  //
  // Each event carries a `link_id` that groups it with the payment card
  // (and any sibling receipt/invoice card) for the same underlying GL
  // transaction. The frontend uses this to highlight invoice ↔ payment
  // pairs when the user clicks either side. link_id is null when there's
  // no payment yet (unpaid invoice).
  const leftEvents = [];

  for (const r of matchedAwaiting) {
    if (!inRange(r.date)) continue;
    const date = isoDate(r.date);
    const isPaid = r.status === "paid";
    const daysOut =
      !isPaid && date ? Math.max(0, daysBetween(date, today)) : null;
    let status = r.status;
    if (
      status === "awaiting" &&
      daysOut != null &&
      daysOut > TIMELINE_OVERDUE_DAYS
    ) {
      status = "overdue";
    }
    leftEvents.push({
      id: r.id,
      kind: r.reference_kind || "invoice",
      date,
      amount: Math.round(Number(r.amount) * 100) / 100,
      currency: r.currency ?? "USD",
      reference_number: r.reference_number ?? null,
      status,
      days_outstanding: daysOut,
      paid_at: r.paid_at
        ? typeof r.paid_at === "string"
          ? r.paid_at.slice(0, 10)
          : new Date(r.paid_at).toISOString().slice(0, 10)
        : null,
      paid_txn_id: r.paid_txn_id ?? null,
      link_id: r.paid_txn_id ?? null,
      description: r.description ?? "",
      vendor: r.vendor,
      source: "awaiting",
    });
  }

  // Left-side cards from the GL side. If the GL row has Documents rows
  // attached (parser-archived PDFs/images), emit ONE left card per doc —
  // so an Anthropic email shipping both an Invoice-XXX.pdf and a
  // Receipt-YYY.pdf renders as two left cards next to one payment card,
  // each tagged with its own reference_kind + reference_number. Fall back
  // to a synthetic card built from the GL row itself when no Documents
  // rows are attached (Record-payment flow with no archived PDF, etc.).
  for (const r of matchedTxns) {
    const date = isoDate(r.date);
    const amount = Math.round(Number(r.amount) * 100) / 100;
    const docs = docsByTxn.get(r.id) ?? [];

    if (docs.length > 0) {
      for (const d of docs) {
        leftEvents.push({
          id: d.id, // Documents row ids are unique across the sheet
          txn_id: r.id, // for dedupe + click → edit-transaction routing
          doc_id: d.id,
          kind: d.reference_kind,
          date,
          amount,
          currency: r.currency ?? "USD",
          reference_number: d.reference_number ?? null,
          status: "paid",
          days_outstanding: null,
          paid_at: date,
          paid_txn_id: r.id,
          link_id: r.id,
          description: r.description ?? "",
          vendor: r.vendor,
          source: "gl",
        });
      }
      continue;
    }

    // Fallback: no doc rows for this txn (Record-payment with no source
    // PDF, or an old GL row archived before the Documents sheet existed).
    // Skip if the GL row itself has no reference_kind — nothing to show.
    if (!r.reference_kind) continue;
    leftEvents.push({
      id: `${r.id}-doc`,
      txn_id: r.id,
      kind: r.reference_kind,
      date,
      amount,
      currency: r.currency ?? "USD",
      reference_number: r.reference_number ?? null,
      status: "paid",
      days_outstanding: null,
      paid_at: date,
      paid_txn_id: r.id,
      link_id: r.id,
      description: r.description ?? "",
      vendor: r.vendor,
      source: "gl",
    });
  }

  const rightEvents = matchedTxns.map((r) => ({
    id: r.id,
    kind: "payment",
    date: isoDate(r.date),
    amount: Math.round(Number(r.amount) * 100) / 100,
    currency: r.currency ?? "USD",
    reference_number: r.reference_number ?? null,
    reference_kind: r.reference_kind ?? null,
    description: r.description ?? "",
    category: r.category ?? null,
    payment_source: r.payment_source ?? null,
    vendor: r.vendor,
    link_id: r.id,
  }));

  const dateSet = new Set([
    ...leftEvents.map((e) => e.date).filter(Boolean),
    ...rightEvents.map((e) => e.date).filter(Boolean),
  ]);
  const rows = [...dateSet]
    .sort((a, b) => b.localeCompare(a))
    .map((d) => ({
      date: d,
      left: leftEvents.filter((e) => e.date === d),
      right: rightEvents.filter((e) => e.date === d),
    }));

  const totalInvoiced = leftEvents
    .filter((e) => e.source === "awaiting")
    .reduce((s, e) => s + e.amount, 0);
  const totalPaid = rightEvents.reduce((s, e) => s + e.amount, 0);
  // Totals dedupe across overlapping representations of the same money:
  //   - Awaiting card always counts (one per AwaitingPayment row).
  //   - GL doc cards on a txn that paid an awaiting → skipped (the
  //     awaiting card already covers that money).
  //   - GL doc cards on an unpaid-via-awaiting txn → count the GL row's
  //     amount ONCE per txn, regardless of how many doc cards we drew
  //     for it (Anthropic ships invoice + receipt = 2 cards, 1 txn).
  const paidTxnIds = new Set(
    matchedAwaiting
      .filter((r) => r.paid_txn_id)
      .map((r) => r.paid_txn_id),
  );
  const totalLeft = (() => {
    let total = 0;
    const countedTxns = new Set();
    for (const e of leftEvents) {
      if (e.source === "awaiting") {
        total += e.amount;
        continue;
      }
      // e.source === "gl"
      const txnId = e.txn_id ?? e.id.replace(/-doc$/, "");
      if (!txnId) continue;
      if (paidTxnIds.has(txnId)) continue; // awaiting already counted this money
      if (countedTxns.has(txnId)) continue; // already counted from a sibling doc card
      countedTxns.add(txnId);
      total += e.amount;
    }
    return total;
  })();
  const totalRight = totalPaid;
  const outstandingInvoices = leftEvents
    .filter(
      (e) =>
        e.source === "awaiting" &&
        (e.status === "awaiting" || e.status === "overdue"),
    )
    .map((e) => ({
      id: e.id,
      vendor: e.vendor,
      reference_number: e.reference_number,
      date: e.date,
      amount: e.amount,
      days_outstanding: e.days_outstanding,
      overdue: e.status === "overdue",
    }));
  const outstandingBalance = outstandingInvoices.reduce(
    (s, i) => s + i.amount,
    0,
  );

  const vendorCounts = new Map();
  for (const e of [...leftEvents, ...rightEvents]) {
    vendorCounts.set(e.vendor, (vendorCounts.get(e.vendor) ?? 0) + 1);
  }
  const distinctVendors = vendorCounts.size;
  const canonicalVendor = vendor
    ? [...vendorCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? vendor
    : null;

  return {
    vendor: canonicalVendor,
    query: vendor || null,
    is_global: !vendor,
    period: { from: from ?? null, to: to ?? null },
    rows,
    summary: {
      total_invoiced: Math.round(totalInvoiced * 100) / 100,
      total_paid: Math.round(totalPaid * 100) / 100,
      total_left: Math.round(totalLeft * 100) / 100,
      total_right: Math.round(totalRight * 100) / 100,
      outstanding_balance: Math.round(outstandingBalance * 100) / 100,
      invoice_count: leftEvents.filter((e) => e.source === "awaiting").length,
      payment_count: rightEvents.length,
      awaiting_count: leftEvents.filter((e) => e.status === "awaiting").length,
      overdue_count: leftEvents.filter((e) => e.status === "overdue").length,
      distinct_vendors: distinctVendors,
      outstanding_invoices: outstandingInvoices,
      overdue_days_threshold: TIMELINE_OVERDUE_DAYS,
      as_of: today,
    },
  };
}

export async function runTool(name, input) {
  const args = input ?? {};
  switch (name) {
    case "list_pending": {
      const rows = await listPending({ status: args.status ?? "pending" });
      return { count: rows.length, entries: rows.map(scrubPending) };
    }
    case "list_transactions": {
      const rows = await listTransactions({
        from: args.from,
        to: args.to,
        category: args.category,
        payment_source: args.payment_source,
      });
      return { count: rows.length, transactions: rows.map(scrubTransaction) };
    }
    case "list_awaiting_payment": {
      let rows = await listAwaiting({ status: args.status ?? "awaiting" });
      if (args.vendor)
        rows = rows.filter((r) => vendorMatches(r.vendor, args.vendor));
      return { count: rows.length, entries: rows.map(scrubAwaiting) };
    }
    case "get_pnl": {
      return computePnl({ from: args.from, to: args.to });
    }
    case "get_categories": {
      const categories = await getCategories({ activeOnly: true });
      return { count: categories.length, categories };
    }
    case "get_payment_sources": {
      const sources = await getPaymentSources({ activeOnly: true });
      return { count: sources.length, sources };
    }
    case "list_documents": {
      const rows = await listDocuments({
        txn_id: args.txn_id,
        pending_id: args.pending_id,
      });
      return { count: rows.length, documents: rows.map(scrubDocument) };
    }

    // ── Render tools ─────────────────────────────────────────────────────
    // Each returns `{ __panel: { kind, title, props }, ...summary }`. The
    // loop strips __panel out, yields it as a `panel` SSE event, and
    // sends the rest to the model as the tool_result.

    case "show_pnl_chart": {
      const pnl = await computePnl({ from: args.from, to: args.to });
      const title = args.title ?? `P&L · ${args.from} – ${args.to}`;
      return {
        __panel: { kind: "pnl_chart", title, props: pnl },
        period: pnl.period,
        total_expense: pnl.total_expense,
        total_count: pnl.total_count,
        categories: pnl.totals_by_category.length,
        top_category:
          pnl.totals_by_category[0]?.category ?? null,
      };
    }

    case "show_transaction_table": {
      const rows = await listTransactions({
        from: args.from,
        to: args.to,
        category: args.category,
        payment_source: args.payment_source,
      });
      let filtered = rows;
      if (args.vendor)
        filtered = filtered.filter((r) => vendorMatches(r.vendor, args.vendor));
      const truncated = filtered.length > TXN_TABLE_LIMIT;
      const view = filtered.slice(0, TXN_TABLE_LIMIT).map(scrubTransaction);
      const filterDesc = describeFilters(args);
      const title =
        args.title ??
        (filterDesc ? `Transactions · ${filterDesc}` : "Transactions");
      const total_amount = filtered.reduce(
        (sum, r) => sum + (Number(r.amount) || 0),
        0,
      );
      return {
        __panel: {
          kind: "transaction_table",
          title,
          props: {
            filters: {
              from: args.from ?? null,
              to: args.to ?? null,
              category: args.category ?? null,
              payment_source: args.payment_source ?? null,
              vendor: args.vendor ?? null,
            },
            count: filtered.length,
            shown: view.length,
            truncated,
            total_amount: Math.round(total_amount * 100) / 100,
            transactions: view,
          },
        },
        count: filtered.length,
        shown: view.length,
        truncated,
        total_amount: Math.round(total_amount * 100) / 100,
      };
    }

    case "show_awaiting_table": {
      let rows = await listAwaiting({ status: "awaiting" });
      if (args.vendor)
        rows = rows.filter((r) => vendorMatches(r.vendor, args.vendor));
      const today = new Date().toISOString().slice(0, 10);
      const entries = rows.map((r) => {
        const scrubbed = scrubAwaiting(r);
        return {
          ...scrubbed,
          days_outstanding:
            scrubbed.date ? Math.max(0, daysBetween(scrubbed.date, today)) : null,
        };
      });
      entries.sort((a, b) => (b.days_outstanding ?? 0) - (a.days_outstanding ?? 0));
      const total_outstanding = entries.reduce(
        (sum, r) => sum + (Number(r.amount) || 0),
        0,
      );
      const title =
        args.title ??
        (args.vendor ? `Outstanding · ${args.vendor}` : "Outstanding invoices");
      return {
        __panel: {
          kind: "awaiting_table",
          title,
          props: {
            count: entries.length,
            total_outstanding: Math.round(total_outstanding * 100) / 100,
            entries,
          },
        },
        count: entries.length,
        total_outstanding: Math.round(total_outstanding * 100) / 100,
      };
    }

    case "show_vendor_timeline": {
      if (!args.vendor) {
        throw new Error("show_vendor_timeline requires 'vendor'");
      }
      const props = await buildTimelineProps({
        vendor: args.vendor,
        from: args.from,
        to: args.to,
      });
      const title = args.title ?? `Timeline · ${props.vendor}`;
      return {
        __panel: { kind: "vendor_timeline", title, props },
        vendor: props.vendor,
        invoice_count: props.summary.invoice_count,
        payment_count: props.summary.payment_count,
        outstanding_balance: props.summary.outstanding_balance,
        overdue_count: props.summary.overdue_count,
      };
    }

    case "show_main_timeline": {
      const props = await buildTimelineProps({
        vendor: null,
        from: args.from,
        to: args.to,
      });
      const title = args.title ?? "All activity";
      return {
        __panel: { kind: "vendor_timeline", title, props },
        invoice_count: props.summary.invoice_count,
        payment_count: props.summary.payment_count,
        distinct_vendors: props.summary.distinct_vendors,
        outstanding_balance: props.summary.outstanding_balance,
        overdue_count: props.summary.overdue_count,
      };
    }

    case "show_file_list": {
      const kindFilter = args.kind ?? "all";
      const hasNarrowingFilter = Boolean(
        args.vendor || args.from || args.to,
      );
      // Include the ledger workbook only when the user is asking broadly
      // (kind='all' with no vendor/date narrowing) or explicitly for the
      // ledger. Asking for 'Anthropic files' or 'all receipt files' should
      // not surface the workbook — it's a system file, not a vendor doc.
      const wantLedger =
        kindFilter === "ledger" ||
        (kindFilter === "all" && !hasNarrowingFilter);
      const wantDocuments = kindFilter !== "ledger";

      const files = [];

      // Pin the ledger workbook at the top when included.
      if (wantLedger) {
        const ledgerPath = getLedgerPath();
        files.push({
          id: "ledger",
          kind: "ledger",
          vendor: null,
          date: null,
          reference_number: null,
          filename: path.basename(ledgerPath),
          download_path: "/api/files/ledger",
          download_filename: path.basename(ledgerPath),
          txn_id: null,
        });
      }

      if (wantDocuments) {
        let docs = await listDocuments();
        if (kindFilter !== "all") {
          docs = docs.filter((d) => d.reference_kind === kindFilter);
        }
        if (args.vendor) {
          docs = docs.filter((d) => vendorMatches(d.vendor, args.vendor));
        }
        if (args.from) {
          docs = docs.filter(
            (d) => d.date && new Date(d.date) >= new Date(args.from),
          );
        }
        if (args.to) {
          docs = docs.filter(
            (d) => d.date && new Date(d.date) <= new Date(args.to),
          );
        }
        docs.sort((a, b) => {
          const ad = isoDate(a.date) ?? "";
          const bd = isoDate(b.date) ?? "";
          return bd.localeCompare(ad);
        });
        const HARD_CAP = 100;
        const requested = Math.min(
          Number.isInteger(args.limit) && args.limit > 0
            ? args.limit
            : HARD_CAP,
          HARD_CAP,
        );
        const truncated = docs.length > requested;
        docs = docs.slice(0, requested);
        for (const d of docs) {
          files.push({
            id: d.id,
            kind: d.reference_kind ?? "other",
            vendor: d.vendor,
            date: isoDate(d.date),
            reference_number: d.reference_number ?? null,
            filename: d.filename,
            download_path: `/api/documents/by-id/${encodeURIComponent(d.id)}`,
            download_filename: d.original_filename || d.filename,
            txn_id: d.txn_id ?? null,
            _truncated_hint: truncated, // for summary; per-row no-op
          });
        }
      }

      const docFiles = files.filter((f) => f.kind !== "ledger");
      const docTruncated = docFiles.some((f) => f._truncated_hint);
      for (const f of files) delete f._truncated_hint;
      const counts = files.reduce((acc, f) => {
        acc[f.kind] = (acc[f.kind] ?? 0) + 1;
        return acc;
      }, {});

      const filterParts = [];
      if (kindFilter !== "all") filterParts.push(`kind=${kindFilter}`);
      if (args.vendor) filterParts.push(`vendor=${args.vendor}`);
      if (args.from && args.to)
        filterParts.push(`${args.from} – ${args.to}`);
      else if (args.from) filterParts.push(`from ${args.from}`);
      else if (args.to) filterParts.push(`through ${args.to}`);
      const filterDesc = filterParts.join(" · ");
      const title =
        args.title ??
        (filterDesc ? `Files · ${filterDesc}` : "Files");

      return {
        __panel: {
          kind: "file_list",
          title,
          props: {
            kind_filter: kindFilter,
            count: files.length,
            truncated: docTruncated,
            counts,
            files,
          },
        },
        count: files.length,
        truncated: docTruncated,
        counts,
      };
    }

    case "show_reconciliation": {
      // Resolve the statement: explicit id wins; otherwise pick by source
      // hint; otherwise just the most recent statement on file.
      let statementId = args.statement_id ?? null;
      if (!statementId) {
        const candidate = await findStatementBySource(args.source ?? null);
        statementId = candidate?.id ?? null;
      }
      if (!statementId) {
        return {
          __panel: {
            kind: "reconciliation",
            title: "Reconciliation",
            props: {
              error: "No statement found to reconcile. Upload a bank or card statement first.",
              statement: null,
              counts: null,
              matched: [],
              unmatched_debits: [],
              unmatched_credits: [],
              unreconciled_gl: [],
              source_diagnostic: null,
            },
          },
          matched: 0,
        };
      }

      // Run auto-match first (idempotent — no-ops if nothing matchable),
      // then build the view from the freshly-persisted state.
      const matchResult = await autoMatchStatement(statementId);
      const view = await buildReconciliationView(statementId);

      return {
        __panel: {
          kind: "reconciliation",
          title: view?.statement?.source
            ? `Reconciliation · ${view.statement.source}`
            : "Reconciliation",
          props: view,
        },
        statement_id: statementId,
        auto_matched_now: matchResult.matched,
        attempted: matchResult.attempted,
        counts: view?.counts ?? null,
      };
    }

    case "show_statements_list": {
      const status = args.status ?? "all";
      let rows = await listStatements({ status });
      if (args.source) rows = rows.filter((r) => r.source === args.source);

      // Pull line counts in one pass so the panel can show them per row
      // without N round trips to the lines sheet.
      const allLines = await listStatementLines();
      const linesByStatement = new Map();
      for (const ln of allLines) {
        const k = ln.statement_id;
        linesByStatement.set(k, (linesByStatement.get(k) ?? 0) + 1);
      }

      const entries = rows
        .map((r) => ({
          id: r.id,
          status: r.status,
          source: r.source,
          period_start: isoDate(r.period_start),
          period_end: isoDate(r.period_end),
          statement_date: isoDate(r.statement_date),
          currency: r.currency ?? "USD",
          opening_balance: r.opening_balance ?? null,
          closing_balance: r.closing_balance ?? null,
          total_charges: r.total_charges ?? null,
          total_payments: r.total_payments ?? null,
          line_count: linesByStatement.get(r.id) ?? 0,
          document_path: r.document_path ?? null,
          download_path: r.document_path
            ? `/api/documents/statement/${encodeURIComponent(r.id)}`
            : null,
          original_filename: r.original_filename ?? null,
          notes: r.notes ?? "",
        }))
        .sort((a, b) =>
          (b.statement_date ?? "").localeCompare(a.statement_date ?? ""),
        );

      const counts = entries.reduce((acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
      }, {});

      const filterParts = [];
      if (status !== "all") filterParts.push(`status=${status}`);
      if (args.source) filterParts.push(`source=${args.source}`);
      const filterDesc = filterParts.join(" · ");
      const title =
        args.title ??
        (filterDesc ? `Statements · ${filterDesc}` : "Statements");

      return {
        __panel: {
          kind: "statements_list",
          title,
          props: {
            status_filter: status,
            count: entries.length,
            counts,
            entries,
          },
        },
        count: entries.length,
        counts,
      };
    }

    case "show_inbox_list": {
      const status = args.status ?? "all";
      const rows = await listPending({ status });
      // Decorate with source kind (email vs upload) inferred from source_file
      // naming. Sort newest-first by received_at.
      const enriched = rows
        .map((r) => {
          const sf = r.source_file ?? "";
          const source_kind = sf.startsWith("upload-")
            ? "upload"
            : sf.startsWith("inbound-")
              ? "email"
              : "other";
          return {
            id: r.id,
            status: r.status,
            received_at: r.received_at
              ? (typeof r.received_at === "string"
                  ? r.received_at
                  : new Date(r.received_at).toISOString())
              : null,
            vendor: r.vendor,
            date: isoDate(r.date),
            total: r.total,
            currency: r.currency ?? "USD",
            reference_number: r.reference_number ?? null,
            reference_kind: r.reference_kind ?? null,
            suggested_category: r.suggested_category ?? null,
            confidence: r.confidence ?? null,
            resolution_notes: r.resolution_notes ?? null,
            source_kind,
          };
        })
        .sort((a, b) => (b.received_at ?? "").localeCompare(a.received_at ?? ""));
      const HARD_CAP = 100;
      const requested = Math.min(
        Number.isInteger(args.limit) && args.limit > 0 ? args.limit : HARD_CAP,
        HARD_CAP,
      );
      const truncated = enriched.length > requested;
      const view = enriched.slice(0, requested);
      const counts = enriched.reduce(
        (acc, r) => {
          acc[r.status] = (acc[r.status] ?? 0) + 1;
          return acc;
        },
        { pending: 0, approved: 0, rejected: 0 },
      );
      const title =
        args.title ??
        (status === "all" ? "Inbox · all items" : `Inbox · ${status}`);
      return {
        __panel: {
          kind: "inbox_list",
          title,
          props: {
            status_filter: status,
            count: enriched.length,
            shown: view.length,
            truncated,
            counts,
            entries: view,
          },
        },
        count: enriched.length,
        shown: view.length,
        truncated,
        counts,
      };
    }

    case "show_vendor_breakdown": {
      const rows = await listTransactions({
        from: args.from,
        to: args.to,
        category: args.category,
      });
      const buckets = new Map();
      let totalExpense = 0;
      for (const r of rows) {
        const vendor = r.vendor || "(no vendor)";
        const amount = Number(r.amount) || 0;
        totalExpense += amount;
        const b = buckets.get(vendor) ?? { vendor, total: 0, count: 0 };
        b.total += amount;
        b.count += 1;
        buckets.set(vendor, b);
      }
      let vendors = [...buckets.values()]
        .map((b) => ({ ...b, total: Math.round(b.total * 100) / 100 }))
        .sort((a, b) => b.total - a.total);
      const HARD_CAP = 50;
      const requested = Math.min(
        Number.isInteger(args.limit) && args.limit > 0 ? args.limit : HARD_CAP,
        HARD_CAP,
      );
      const truncated = vendors.length > requested;
      vendors = vendors.slice(0, requested);
      const periodDesc =
        args.from && args.to
          ? `${args.from} – ${args.to}`
          : args.from
            ? `from ${args.from}`
            : args.to
              ? `through ${args.to}`
              : "all time";
      const title =
        args.title ??
        (args.category
          ? `Vendors · ${args.category} · ${periodDesc}`
          : `Vendors · ${periodDesc}`);
      const props = {
        period: { from: args.from ?? null, to: args.to ?? null },
        category: args.category ?? null,
        count: vendors.length,
        total_count: rows.length,
        total_expense: Math.round(totalExpense * 100) / 100,
        truncated,
        vendors,
      };
      return {
        __panel: { kind: "vendor_breakdown", title, props },
        count: vendors.length,
        total_count: rows.length,
        total_expense: props.total_expense,
        truncated,
        top_vendor: vendors[0]?.vendor ?? null,
      };
    }

    case "show_kpi_summary": {
      const today = new Date();
      const ymdToday = today.toISOString().slice(0, 10);
      const yearStart = `${today.getUTCFullYear()}-01-01`;
      const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

      const [pending, ytdTxns, awaiting, recentTxns] = await Promise.all([
        listPending({ status: "pending" }),
        listTransactions({ from: yearStart, to: ymdToday }),
        listAwaiting({ status: "awaiting" }),
        listTransactions({ from: thirtyDaysAgo, to: ymdToday }),
      ]);

      const ytdSpend = ytdTxns.reduce(
        (s, r) => s + (Number(r.amount) || 0),
        0,
      );
      const outstanding = awaiting.reduce(
        (s, r) => s + (Number(r.amount) || 0),
        0,
      );
      const recent30dSpend = recentTxns.reduce(
        (s, r) => s + (Number(r.amount) || 0),
        0,
      );

      const props = {
        as_of: ymdToday,
        pending_count: pending.length,
        ytd_spend: Math.round(ytdSpend * 100) / 100,
        ytd_count: ytdTxns.length,
        outstanding_total: Math.round(outstanding * 100) / 100,
        outstanding_count: awaiting.length,
        recent_30d_spend: Math.round(recent30dSpend * 100) / 100,
        recent_30d_count: recentTxns.length,
      };
      return {
        __panel: {
          kind: "kpi_summary",
          title: args.title ?? `State of the books · ${ymdToday}`,
          props,
        },
        ...props,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
