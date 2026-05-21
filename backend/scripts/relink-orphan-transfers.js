// One-off (idempotent) repair: link existing Transfers to their settling
// AwaitingPayment rows when mark-as-transfer was used BEFORE the auto-link
// logic landed in routes.js.
//
// Heuristic — matches the live findOutstandingAwaitingTransfer():
//   - awaiting.status === "awaiting"
//   - awaiting.payment_kind === "transfer"
//   - awaiting.amount within $0.01 of the transfer's amount
//   - awaiting.vendor matches Transfer.to_source OR Transfer.from_source by
//     case-insensitive name OR last-4 marker
// Links only when EXACTLY ONE awaiting matches (ambiguous matches are
// flagged but skipped — fix by hand).
//
// USAGE:
//   node scripts/relink-orphan-transfers.js --dry-run    # show what it would do
//   node scripts/relink-orphan-transfers.js              # apply

import { existsSync } from "node:fs";
import * as path from "node:path";
import {
  listTransfers,
  listAwaiting,
  listStatements,
  updateTransfer,
  updateAwaiting,
  markAwaitingPaid,
} from "../src/ledger/index.js";

const ENV_PATH = path.resolve(import.meta.dirname, "..", ".env");
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const DRY_RUN = process.argv.includes("--dry-run");

function extractLast4(s) {
  if (!s) return null;
  const m = String(s).match(/(?:••?|\*\*|-)\s*(\d{4})\b/);
  return m ? m[1] : null;
}
function sameAccountName(a, b) {
  if (!a || !b) return false;
  const aa = String(a).toLowerCase().trim();
  const bb = String(b).toLowerCase().trim();
  if (aa === bb) return true;
  const la = extractLast4(a);
  const lb = extractLast4(b);
  return !!(la && lb && la === lb);
}

function findUniqueSubsetSummingTo(items, target, tolerance = 0.01) {
  const N = items.length;
  if (N === 0 || N > 16) return null;
  let foundMask = -1;
  for (let mask = 1; mask < 1 << N; mask++) {
    let sum = 0;
    for (let i = 0; i < N; i++) {
      if (mask & (1 << i)) sum += Number(items[i].amount);
    }
    if (Math.abs(sum - target) <= tolerance) {
      if (foundMask !== -1) return null;
      foundMask = mask;
    }
  }
  if (foundMask === -1) return null;
  const out = [];
  for (let i = 0; i < N; i++) {
    if (foundMask & (1 << i)) out.push(items[i]);
  }
  return out;
}

const transfers = await listTransfers();
const awaitings = await listAwaiting({ status: "awaiting" });
const allStatements = await listStatements({ status: "all" });

const unlinkedTransfers = transfers.filter((t) => !t.awaiting_id);

let linkedSets = 0;
let linkedTransfersCount = 0;
let linkedOverpayments = 0;
const usedTransferIds = new Set();

// Helper: same next-period statement lookup the live endpoint uses.
function findNextStatementForAwaiting(aw) {
  if (!aw?.statement_id) return null;
  const origin = allStatements.find((s) => s.id === aw.statement_id);
  if (!origin?.period_end) return null;
  const originEnd = new Date(origin.period_end);
  const after = allStatements
    .filter(
      (s) =>
        s.id !== origin.id &&
        sameAccountName(s.source, origin.source) &&
        s.period_start &&
        new Date(s.period_start) >= originEnd,
    )
    .sort((a, b) => new Date(a.period_start) - new Date(b.period_start));
  return after[0] ?? null;
}

const awaitingsSorted = [...awaitings]
  .filter(
    (aw) =>
      (aw.payment_kind || "expense") === "transfer" && !aw.paid_transfer_id,
  )
  .sort((a, b) => Number(a.amount) - Number(b.amount));

// ── Pass 1: exact subset-sum (within $0.01) ─────────────────────────
for (const aw of awaitingsSorted) {
  const eligible = unlinkedTransfers.filter(
    (t) =>
      !usedTransferIds.has(t.id) && sameAccountName(t.to_source, aw.vendor),
  );
  if (eligible.length === 0) continue;
  const target = Math.abs(Number(aw.amount));
  const subset = findUniqueSubsetSummingTo(eligible, target, 0.01);
  if (!subset) continue;
  console.log(
    `  ${subset.length === 1 ? "1:1" : `${subset.length}:1`} exact: awaiting ${aw.id} (${aw.vendor}, $${aw.amount}) via [${subset.map((t) => `${t.id}/$${Math.abs(Number(t.amount))}`).join(", ")}]`,
  );
  if (!DRY_RUN) {
    for (const t of subset) {
      await updateTransfer(t.id, { awaiting_id: aw.id });
    }
    await markAwaitingPaid(aw.id, { paid_transfer_id: subset[0].id });
  }
  for (const t of subset) usedTransferIds.add(t.id);
  linkedSets++;
  linkedTransfersCount += subset.length;
}

// ── Pass 2: single-transfer overpayment within carry-forward window ──
for (const aw of awaitingsSorted) {
  // Skip if pass 1 already settled this awaiting.
  if (aw.paid_transfer_id) continue;
  const awAmount = Math.abs(Number(aw.amount));
  const eligible = unlinkedTransfers.filter(
    (t) =>
      !usedTransferIds.has(t.id) &&
      sameAccountName(t.to_source, aw.vendor) &&
      Math.abs(Number(t.amount)) >= awAmount,
  );
  if (eligible.length === 0) continue;
  const nextStmt = findNextStatementForAwaiting(aw);
  if (!nextStmt) continue;
  const nextCharges = Number(nextStmt.total_charges);
  if (!Number.isFinite(nextCharges) || nextCharges < 0) continue;
  const upperBound = awAmount + nextCharges;
  const inWindow = eligible.filter(
    (t) => Math.abs(Number(t.amount)) <= upperBound + 0.01,
  );
  if (inWindow.length !== 1) continue; // ambiguous or none
  const t = inWindow[0];
  const trAmount = Math.abs(Number(t.amount));
  const overpayment = Math.round((trAmount - awAmount) * 100) / 100;
  console.log(
    `  1:1 overpay: awaiting ${aw.id} (${aw.vendor}, $${aw.amount}) via ${t.id} ($${trAmount}) — overpaid $${overpayment.toFixed(2)}, applied to next statement ${nextStmt.id}`,
  );
  if (!DRY_RUN) {
    await updateTransfer(t.id, { awaiting_id: aw.id });
    const existingNotes = aw.notes || "";
    const overNote = `Overpaid by $${overpayment.toFixed(2)} via xfer ${t.id} — applied to next statement (${nextStmt.id}).`;
    const combinedNotes = existingNotes
      ? `${existingNotes}\n${overNote}`
      : overNote;
    await updateAwaiting(aw.id, { notes: combinedNotes });
    await markAwaitingPaid(aw.id, { paid_transfer_id: t.id });
  }
  usedTransferIds.add(t.id);
  linkedSets++;
  linkedTransfersCount++;
  linkedOverpayments++;
}

// Pass 2: show the orphans the script left behind, with diagnostic
// hints so the user can decide whether the data is legitimately
// unmatched (e.g. payments toward a now-superseded older statement).
const remaining = unlinkedTransfers.filter((t) => !usedTransferIds.has(t.id));
for (const t of remaining) {
  const amount = Math.abs(Number(t.amount));
  const sameVendor = awaitings.filter(
    (aw) =>
      sameAccountName(aw.vendor, t.to_source) ||
      sameAccountName(aw.vendor, t.from_source),
  );
  console.log(
    `  unlinked: transfer ${t.id} ($${amount}, ${t.from_source} → ${t.to_source}, ${t.date && (typeof t.date === "string" ? t.date.slice(0, 10) : new Date(t.date).toISOString().slice(0, 10))})`,
  );
  if (sameVendor.length > 0) {
    console.log(
      `    vendor-matching awaitings: ${sameVendor.map((a) => `${a.id}/$${a.amount}`).join(", ")}`,
    );
  }
}

console.log("");
console.log(
  `Linked subsets:        ${linkedSets}${DRY_RUN ? " (dry-run, not written)" : ""}`,
);
console.log(`  of which overpay:    ${linkedOverpayments}`);
console.log(`Linked transfers:      ${linkedTransfersCount}`);
console.log(`Still unlinked:        ${remaining.length}`);
