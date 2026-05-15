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
  getLedgerPath,
} from "../ledger/index.js";

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
      const today = new Date().toISOString().slice(0, 10);
      const OVERDUE_DAYS = 30;

      const awaitingAll = await listAwaiting({ status: "all" });
      const txnAll = await listTransactions({ from: args.from, to: args.to });

      const matchedInvoices = awaitingAll.filter((r) =>
        vendorMatches(r.vendor, args.vendor),
      );
      const matchedPayments = txnAll.filter((r) =>
        vendorMatches(r.vendor, args.vendor),
      );

      // Apply optional date range to invoices too. (txnAll already filtered.)
      const inRange = (d) => {
        const iso = isoDate(d);
        if (!iso) return false;
        if (args.from && iso < args.from) return false;
        if (args.to && iso > args.to) return false;
        return true;
      };

      const invoices = matchedInvoices
        .filter((r) => inRange(r.date))
        .map((r) => {
          const date = isoDate(r.date);
          const isPaid = r.status === "paid";
          const days_outstanding =
            !isPaid && date ? Math.max(0, daysBetween(date, today)) : null;
          let status = r.status; // awaiting | paid | written_off | rejected
          if (status === "awaiting" && days_outstanding != null && days_outstanding > OVERDUE_DAYS) {
            status = "overdue";
          }
          return {
            id: r.id,
            date,
            amount: Math.round(Number(r.amount) * 100) / 100,
            currency: r.currency ?? "USD",
            reference_number: r.reference_number ?? null,
            reference_kind: r.reference_kind ?? null,
            description: r.description ?? "",
            status, // awaiting | overdue | paid | written_off | rejected
            days_outstanding,
            paid_at: r.paid_at
              ? typeof r.paid_at === "string"
                ? r.paid_at.slice(0, 10)
                : new Date(r.paid_at).toISOString().slice(0, 10)
              : null,
            paid_txn_id: r.paid_txn_id ?? null,
            vendor: r.vendor,
          };
        });

      const payments = matchedPayments.map((r) => ({
        id: r.id,
        date: isoDate(r.date),
        amount: Math.round(Number(r.amount) * 100) / 100,
        currency: r.currency ?? "USD",
        reference_number: r.reference_number ?? null,
        reference_kind: r.reference_kind ?? null,
        description: r.description ?? "",
        category: r.category ?? null,
        payment_source: r.payment_source ?? null,
        vendor: r.vendor,
      }));

      // Build per-date rows. Each row may have 0+ invoices and 0+ payments.
      const dateSet = new Set([
        ...invoices.map((i) => i.date).filter(Boolean),
        ...payments.map((p) => p.date).filter(Boolean),
      ]);
      const rows = [...dateSet].sort().map((d) => ({
        date: d,
        invoices: invoices.filter((i) => i.date === d),
        payments: payments.filter((p) => p.date === d),
      }));

      const totalInvoiced = invoices.reduce((s, i) => s + i.amount, 0);
      const totalPaid = payments.reduce((s, p) => s + p.amount, 0);
      const outstandingInvoices = invoices
        .filter((i) => i.status === "awaiting" || i.status === "overdue")
        .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))
        .map((i) => ({
          id: i.id,
          reference_number: i.reference_number,
          date: i.date,
          amount: i.amount,
          days_outstanding: i.days_outstanding,
          overdue: i.status === "overdue",
        }));
      const outstandingBalance = outstandingInvoices.reduce(
        (s, i) => s + i.amount,
        0,
      );

      // Pick a canonical vendor name to display. Most queries match one
      // vendor; if multiple, pick the one with the most events.
      const vendorCounts = new Map();
      for (const e of [...invoices, ...payments]) {
        vendorCounts.set(e.vendor, (vendorCounts.get(e.vendor) ?? 0) + 1);
      }
      const canonicalVendor =
        [...vendorCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
        args.vendor;

      const props = {
        vendor: canonicalVendor,
        query: args.vendor,
        period: { from: args.from ?? null, to: args.to ?? null },
        rows,
        invoices,
        payments,
        summary: {
          total_invoiced: Math.round(totalInvoiced * 100) / 100,
          total_paid: Math.round(totalPaid * 100) / 100,
          outstanding_balance: Math.round(outstandingBalance * 100) / 100,
          invoice_count: invoices.length,
          payment_count: payments.length,
          awaiting_count: invoices.filter((i) => i.status === "awaiting")
            .length,
          overdue_count: invoices.filter((i) => i.status === "overdue").length,
          paid_invoice_count: invoices.filter((i) => i.status === "paid")
            .length,
          outstanding_invoices: outstandingInvoices,
          overdue_days_threshold: OVERDUE_DAYS,
          as_of: today,
        },
      };

      const title = args.title ?? `Timeline · ${canonicalVendor}`;
      return {
        __panel: { kind: "vendor_timeline", title, props },
        vendor: canonicalVendor,
        invoice_count: invoices.length,
        payment_count: payments.length,
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
