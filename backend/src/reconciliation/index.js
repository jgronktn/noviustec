// Statement reconciliation — match StatementLines against GL transactions.
//
// Slice 1 scope:
//   - autoMatchStatement(statementId): greedy heuristic match for any
//     unmatched negative-amount lines. Persists matches with
//     match_method="auto" to StatementLines.
//   - buildReconciliationView(statementId): everything the dashboard
//     panel needs to render in one payload — matched pairs, unmatched
//     statement lines, GL rows in the source/period that nothing
//     matched, plus diagnostics for the source-name normalization
//     issue (most common reason for empty match results).
//
// Out of scope (deferred):
//   - "Book as a new transaction" from an unmatched line.
//   - Income-side matching for credit lines (deposits).
//   - Split / partial matches (one line ↔ multiple GL rows).

import {
  getStatement,
  listStatements,
  listStatementLines,
  listTransactions,
  updateStatementLine,
  updateStatement,
} from "../ledger/index.js";

// ── Match heuristic configuration ────────────────────────────────────
const DATE_WINDOW_DAYS = 5; // ± days each side of line_date
const AMOUNT_TOLERANCE = 0.01; // dollars

function toIsoDate(v) {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return null;
}

function daysBetween(a, b) {
  const da = new Date(toIsoDate(a));
  const db = new Date(toIsoDate(b));
  return Math.abs(da - db) / (24 * 60 * 60 * 1000);
}

function addDays(iso, n) {
  if (!iso) return null;
  const d = new Date(toIsoDate(iso));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function extractLast4(s) {
  if (!s) return null;
  // Accept "••XXXX", "•XXXX", "**XXXX", "XX-XXXX", etc.
  const m = String(s).match(/(?:••?|\*\*|-)\s*(\d{4})\b/);
  return m ? m[1] : null;
}

/**
 * Decide whether a statement's source name and a GL row's payment_source
 * are the same account. Order of strictness:
 *   1. Exact (case-insensitive, whitespace-trimmed)
 *   2. Both have a ••NNNN last-4 marker AND the digits match
 * Anything else: no match — the user gets to see the divergence in the
 * diagnostic block on the panel and normalize via the Edit dialog.
 */
function sourceMatches(stmtSource, glSource) {
  if (!stmtSource || !glSource) return false;
  const a = stmtSource.toLowerCase().trim();
  const b = glSource.toLowerCase().trim();
  if (a === b) return true;
  const la = extractLast4(stmtSource);
  const lb = extractLast4(glSource);
  if (la && lb && la === lb) return true;
  return false;
}

/**
 * Run the greedy auto-match against a statement's unmatched lines.
 * Idempotent — already-matched lines (manual or auto) are left alone.
 * Returns counts + the list of new matches applied.
 */
export async function autoMatchStatement(statementId) {
  const stmt = await getStatement(statementId);
  if (!stmt) throw new Error(`Statement not found: ${statementId}`);

  const allLinesGlobal = await listStatementLines();
  const lines = allLinesGlobal.filter((l) => l.statement_id === statementId);

  // GL rows that are already paired to some line — anywhere, across any
  // statement — to avoid double-matching one txn to two lines.
  const txnIdsAlreadyMatched = new Set(
    allLinesGlobal
      .filter((l) => l.matched_txn_id)
      .map((l) => l.matched_txn_id),
  );

  const unmatched = lines.filter((l) => !l.matched_txn_id);
  const matchableUnmatched = unmatched.filter(
    (l) => Number(l.amount) < 0, // skip credits — no income side yet
  );

  if (matchableUnmatched.length === 0) {
    await refreshStatementStatus(statementId, lines);
    return {
      statement_id: statementId,
      matched: 0,
      attempted: 0,
      skipped_credits: unmatched.filter((l) => Number(l.amount) >= 0).length,
    };
  }

  // Pull GL with a generous padding around the period.
  const periodStart = toIsoDate(stmt.period_start);
  const periodEnd = toIsoDate(stmt.period_end);
  const from = periodStart ? addDays(periodStart, -DATE_WINDOW_DAYS) : undefined;
  const to = periodEnd ? addDays(periodEnd, DATE_WINDOW_DAYS) : undefined;
  const allGl = await listTransactions({ from, to });

  const candidateGl = allGl.filter((g) =>
    sourceMatches(stmt.source, g.payment_source),
  );

  const newMatches = [];
  for (const line of matchableUnmatched) {
    const lineAmount = Math.abs(Number(line.amount));
    let best = null; // { txn, daysOff }
    for (const g of candidateGl) {
      if (txnIdsAlreadyMatched.has(g.id)) continue;
      const amountDiff = Math.abs(Number(g.amount) - lineAmount);
      if (amountDiff > AMOUNT_TOLERANCE) continue;
      const daysOff = daysBetween(line.line_date, g.date);
      if (daysOff > DATE_WINDOW_DAYS) continue;
      if (!best || daysOff < best.daysOff) {
        best = { txn: g, daysOff };
      }
    }
    if (best) {
      newMatches.push({
        line_id: line.id,
        txn_id: best.txn.id,
        days_off: best.daysOff,
      });
      txnIdsAlreadyMatched.add(best.txn.id);
    }
  }

  for (const m of newMatches) {
    await updateStatementLine(m.line_id, {
      matched_txn_id: m.txn_id,
      match_method: "auto",
    });
  }

  // Re-read to reflect persisted state, then update Statement.status.
  const linesAfter = (await listStatementLines()).filter(
    (l) => l.statement_id === statementId,
  );
  await refreshStatementStatus(statementId, linesAfter);

  return {
    statement_id: statementId,
    matched: newMatches.length,
    attempted: matchableUnmatched.length,
    skipped_credits: unmatched.filter((l) => Number(l.amount) >= 0).length,
    matches: newMatches,
  };
}

/**
 * Derive + persist the Statement's reconciliation status from its lines.
 * Status convention:
 *   reconciled              — every NEGATIVE-amount line is matched
 *   partially_reconciled    — some negative lines matched, not all
 *   imported                — no negative lines matched yet
 * Credits (positive amounts) are excluded from the calculus until the
 * income side of the books exists.
 */
async function refreshStatementStatus(statementId, lines) {
  const negs = lines.filter((l) => Number(l.amount) < 0);
  const matched = negs.filter((l) => l.matched_txn_id).length;
  let status = "imported";
  if (negs.length > 0 && matched === negs.length) status = "reconciled";
  else if (matched > 0) status = "partially_reconciled";
  // Only write if changed — keep churn low.
  const stmt = await getStatement(statementId);
  if (stmt && stmt.status !== status) {
    await updateStatement(statementId, { status });
  }
  return status;
}

// ── View builder (panel payload) ─────────────────────────────────────

function scrubLine(line) {
  return {
    id: line.id,
    statement_id: line.statement_id,
    line_date: toIsoDate(line.line_date),
    description: line.description ?? "",
    amount:
      line.amount == null
        ? null
        : Math.round(Number(line.amount) * 100) / 100,
    balance_after:
      line.balance_after == null
        ? null
        : Math.round(Number(line.balance_after) * 100) / 100,
    matched_txn_id: line.matched_txn_id ?? null,
    match_method: line.match_method ?? null,
    notes: line.notes ?? "",
  };
}

function scrubGlMinimal(g) {
  return {
    id: g.id,
    date: toIsoDate(g.date),
    vendor: g.vendor ?? null,
    description: g.description ?? "",
    category: g.category ?? null,
    payment_source: g.payment_source ?? null,
    amount: g.amount == null ? null : Math.round(Number(g.amount) * 100) / 100,
    currency: g.currency ?? "USD",
    reference_number: g.reference_number ?? null,
    reference_kind: g.reference_kind ?? null,
  };
}

function scrubStatement(s) {
  return {
    id: s.id,
    status: s.status,
    source: s.source,
    period_start: toIsoDate(s.period_start),
    period_end: toIsoDate(s.period_end),
    statement_date: toIsoDate(s.statement_date),
    currency: s.currency ?? "USD",
    opening_balance: s.opening_balance ?? null,
    closing_balance: s.closing_balance ?? null,
    total_charges: s.total_charges ?? null,
    total_payments: s.total_payments ?? null,
    document_path: s.document_path ?? null,
  };
}

/**
 * Assemble the full reconciliation payload for the panel:
 *   - statement summary (source, period, balances, status)
 *   - counts ({total_lines, matched, unmatched_debit, unmatched_credit,
 *     unreconciled_gl})
 *   - matched pairs (line + the GL row it points at)
 *   - unmatched lines (split into debit and credit for UI clarity)
 *   - unreconciled GL rows in the same source+period not pointed to by
 *     any line on this statement
 *   - source_diagnostic — surfaces the most common foot-gun: GL rows
 *     for this period whose payment_source name doesn't match the
 *     statement's stored source name closely enough to auto-match.
 */
export async function buildReconciliationView(statementId) {
  const stmt = await getStatement(statementId);
  if (!stmt) return null;

  const lines = (await listStatementLines()).filter(
    (l) => l.statement_id === statementId,
  );

  // Look at GL rows for the period, with padding.
  const periodStart = toIsoDate(stmt.period_start);
  const periodEnd = toIsoDate(stmt.period_end);
  const from = periodStart ? addDays(periodStart, -DATE_WINDOW_DAYS) : undefined;
  const to = periodEnd ? addDays(periodEnd, DATE_WINDOW_DAYS) : undefined;
  const allGl = await listTransactions({ from, to });
  const glById = new Map(allGl.map((g) => [g.id, g]));
  const candidateGl = allGl.filter((g) =>
    sourceMatches(stmt.source, g.payment_source),
  );

  const matchedTxnIds = new Set(
    lines.filter((l) => l.matched_txn_id).map((l) => l.matched_txn_id),
  );

  const matched = [];
  const unmatchedDebits = [];
  const unmatchedCredits = [];
  for (const line of lines) {
    const scrubbed = scrubLine(line);
    if (line.matched_txn_id) {
      const gl = glById.get(line.matched_txn_id);
      matched.push({
        ...scrubbed,
        matched_txn: gl ? scrubGlMinimal(gl) : null,
      });
    } else if (Number(line.amount) < 0) {
      unmatchedDebits.push(scrubbed);
    } else {
      unmatchedCredits.push(scrubbed);
    }
  }

  const unreconciledGl = candidateGl
    .filter((g) => !matchedTxnIds.has(g.id))
    .map(scrubGlMinimal)
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  // Diagnostic: payment_sources we saw on GL rows for this period that
  // weren't matched against the statement source — most common cause of
  // an empty reconciliation result.
  const glSourcesSeen = new Map(); // name → count
  for (const g of allGl) {
    const s = g.payment_source;
    if (!s) continue;
    glSourcesSeen.set(s, (glSourcesSeen.get(s) ?? 0) + 1);
  }

  const sourcesNotMatched = [...glSourcesSeen.entries()]
    .filter(([s]) => !sourceMatches(stmt.source, s))
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return {
    statement: scrubStatement(stmt),
    counts: {
      total_lines: lines.length,
      matched: matched.length,
      unmatched_debit: unmatchedDebits.length,
      unmatched_credit: unmatchedCredits.length,
      unreconciled_gl: unreconciledGl.length,
    },
    matched,
    unmatched_debits: unmatchedDebits,
    unmatched_credits: unmatchedCredits,
    unreconciled_gl: unreconciledGl,
    source_diagnostic: {
      statement_source: stmt.source,
      gl_sources_in_period: [...glSourcesSeen.entries()].map(
        ([name, count]) => ({ name, count }),
      ),
      gl_sources_not_matching: sourcesNotMatched,
      gl_matched_count: candidateGl.length,
    },
  };
}

/**
 * Quick helper for the agent tool — pick a single statement when the
 * agent doesn't have an explicit statement_id. With a query, prefer a
 * source substring match; if nothing matches, fall back to the most
 * recent statement so the panel can still render something useful
 * (the empty-result panel was confusing — looked like no statements
 * existed at all).
 */
export async function findStatementBySource(query) {
  const all = await listStatements({ status: "all" });
  if (all.length === 0) return null;
  const sortedByDateDesc = [...all].sort((a, b) =>
    (toIsoDate(b.statement_date) ?? "").localeCompare(
      toIsoDate(a.statement_date) ?? "",
    ),
  );
  if (!query) return sortedByDateDesc[0];
  const q = String(query).toLowerCase();
  const matches = sortedByDateDesc.filter(
    (s) => s.source && s.source.toLowerCase().includes(q),
  );
  if (matches.length > 0) return matches[0];
  // Query didn't match anything — better to show the most recent
  // statement than nothing at all. Caller can decide what to do.
  return sortedByDateDesc[0];
}
