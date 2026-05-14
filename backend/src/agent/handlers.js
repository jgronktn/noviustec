// Tool dispatcher for the bookkeeping agent.
//
// Maps Anthropic tool_use names to the existing ledger read functions, with
// light post-processing (date → ISO string, group-by for P&L, scrub
// filesystem paths). Returns plain JSON-serializable objects.

import {
  listPending,
  listTransactions,
  listAwaiting,
  getCategories,
  getPaymentSources,
  listDocuments,
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
      if (args.vendor) rows = rows.filter((r) => r.vendor === args.vendor);
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
      if (args.vendor) filtered = filtered.filter((r) => r.vendor === args.vendor);
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
      if (args.vendor) rows = rows.filter((r) => r.vendor === args.vendor);
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
