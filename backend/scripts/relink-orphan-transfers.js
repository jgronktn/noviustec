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
  updateTransfer,
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

const transfers = await listTransfers();
const awaitings = await listAwaiting({ status: "awaiting" });

let linked = 0;
let skippedAmbiguous = 0;
let skippedNoMatch = 0;
let alreadyLinked = 0;

for (const t of transfers) {
  if (t.awaiting_id) {
    alreadyLinked++;
    continue;
  }
  const amount = Math.abs(Number(t.amount));
  const candidates = awaitings.filter((aw) => {
    if (aw.paid_transfer_id) return false; // already settled by something else
    if ((aw.payment_kind || "expense") !== "transfer") return false;
    if (Math.abs(Number(aw.amount) - amount) > 0.01) return false;
    return (
      sameAccountName(aw.vendor, t.to_source) ||
      sameAccountName(aw.vendor, t.from_source)
    );
  });

  if (candidates.length === 0) {
    skippedNoMatch++;
    continue;
  }
  if (candidates.length > 1) {
    console.log(
      `  AMBIGUOUS: transfer ${t.id} ($${amount}) matches ${candidates.length} awaitings: ${candidates.map((c) => c.id).join(", ")}`,
    );
    skippedAmbiguous++;
    continue;
  }
  const aw = candidates[0];
  console.log(
    `  link transfer ${t.id} ($${amount}, ${t.from_source}→${t.to_source}) → awaiting ${aw.id} (${aw.vendor})`,
  );
  if (!DRY_RUN) {
    await updateTransfer(t.id, { awaiting_id: aw.id });
    await markAwaitingPaid(aw.id, { paid_transfer_id: t.id });
    // Pull the awaiting out of the pool so it can't be matched twice.
    const i = awaitings.indexOf(aw);
    if (i >= 0) awaitings.splice(i, 1);
  }
  linked++;
}

console.log("");
console.log(`Linked:           ${linked}${DRY_RUN ? " (dry-run, not written)" : ""}`);
console.log(`Already linked:   ${alreadyLinked}`);
console.log(`No match:         ${skippedNoMatch}`);
console.log(`Ambiguous:        ${skippedAmbiguous}`);
