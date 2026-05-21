<script setup>
import { computed } from "vue";

const props = defineProps({
  data: { type: Object, required: true },
});

function fmt(amount, currency = "USD") {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function shortDate(d) {
  return d ? String(d).slice(0, 10) : "—";
}

function shortMonth(yyyyMm) {
  const [y, m] = yyyyMm.split("-").map(Number);
  const names = [
    "Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec",
  ];
  return `${names[m - 1]} ${y}`;
}

function kindLabel(kind) {
  if (kind === "credit_card") return "Credit Card";
  if (kind === "bank_account") return "Bank";
  return "Statement";
}

function kindClass(kind) {
  if (kind === "credit_card") return "kind-card";
  if (kind === "bank_account") return "kind-bank";
  return "kind-other";
}

function statusClass(status) {
  return `status-${status || "imported"}`;
}

// Group statements by month (YYYY-MM). Each month becomes a section
// with the month label, the TODAY marker if it falls in that month,
// and one row per statement. Sections render with a min-height so a
// month with one statement still occupies visible vertical space,
// making elapsed time legible at a glance.
const todayIso = new Date().toISOString().slice(0, 10);
const todayYm = todayIso.slice(0, 7);

const monthSections = computed(() => {
  const rows = props.data?.statements ?? [];
  if (rows.length === 0) return [];

  // Build the full month range from oldest statement → max(latest statement, today)
  // so empty months in between still appear with vertical space.
  const dates = rows
    .map((s) => s.statement_date || s.period_end)
    .filter(Boolean)
    .sort();
  const oldestYm = dates[0].slice(0, 7);
  const latestYm = dates[dates.length - 1].slice(0, 7);
  const endYm = latestYm > todayYm ? latestYm : todayYm;

  const monthsAsc = [];
  let cursor = oldestYm;
  while (cursor <= endYm) {
    monthsAsc.push(cursor);
    cursor = nextMonth(cursor);
  }
  // Render newest-first to match the vendor timeline's orientation.
  const monthsDesc = monthsAsc.reverse();

  const rowsByMonth = new Map();
  for (const s of rows) {
    const date = s.statement_date || s.period_end || "";
    const ym = date.slice(0, 7);
    if (!rowsByMonth.has(ym)) rowsByMonth.set(ym, []);
    rowsByMonth.get(ym).push(s);
  }

  return monthsDesc.map((ym) => ({
    ym,
    statements: rowsByMonth.get(ym) ?? [],
    hasToday: ym === todayYm,
  }));
});

function nextMonth(yyyyMm) {
  const [y, m] = yyyyMm.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1)); // m is 0-indexed; m here = next month
  return d.toISOString().slice(0, 7);
}
</script>

<template>
  <div class="st-root">
    <header class="st-head">
      <div class="st-head-main">
        <h3 class="st-title">Statement activity</h3>
        <p class="st-sub">
          {{ data.count }} statement<span v-if="data.count !== 1">s</span>
          <span v-if="data.counts?.by_kind">
            ·
            <span v-if="data.counts.by_kind.credit_card">
              {{ data.counts.by_kind.credit_card }} card
            </span>
            <span v-if="data.counts.by_kind.credit_card && data.counts.by_kind.bank_account">
              ·
            </span>
            <span v-if="data.counts.by_kind.bank_account">
              {{ data.counts.by_kind.bank_account }} bank
            </span>
          </span>
        </p>
      </div>
      <div class="st-totals">
        <div class="st-total">
          <span class="st-total-label">Total charges</span>
          <span class="st-total-amount mono">{{ fmt(data.totals?.charges ?? 0) }}</span>
        </div>
        <div class="st-total">
          <span class="st-total-label">Total payments</span>
          <span class="st-total-amount mono">{{ fmt(data.totals?.payments ?? 0) }}</span>
        </div>
      </div>
    </header>

    <div v-if="data.count === 0" class="st-empty">
      No statements match the filter.
    </div>

    <div v-else class="st-timeline">
      <section
        v-for="sec in monthSections"
        :key="sec.ym"
        class="st-month-section"
      >
        <header class="st-month-tick">
          <span class="st-month-label">{{ shortMonth(sec.ym) }}</span>
        </header>
        <div v-if="sec.hasToday" class="st-today">
          <span class="st-today-word">TODAY</span>
          <span class="st-today-date">{{ shortDate(todayIso) }}</span>
        </div>
        <!-- Card statements live on the left, bank statements on the
             right. The center axis (date + dot) separates them, same
             as the vendor timeline. -->
        <div
          v-for="stmt in sec.statements"
          :key="stmt.id"
          class="st-row"
        >
          <div class="st-side st-left">
            <div
              v-if="stmt.source_kind === 'credit_card'"
              class="st-card kind-card"
            >
              <span class="st-card-kind">{{ kindLabel(stmt.source_kind) }}</span>
              <span class="st-card-source">{{ stmt.source }}</span>
              <span class="st-card-period mono">
                {{ shortDate(stmt.period_start) }} →
                {{ shortDate(stmt.period_end) }}
              </span>
              <span class="st-card-amount mono">
                {{ fmt(stmt.closing_balance, stmt.currency) }}
              </span>
              <span class="status-pill" :class="statusClass(stmt.status)">
                {{ (stmt.status || "imported").replace(/_/g, " ") }}
              </span>
              <a
                v-if="stmt.download_path"
                :href="stmt.download_path"
                target="_blank"
                rel="noopener"
                class="st-link"
                title="Download original PDF"
              >PDF</a>
            </div>
          </div>
          <div class="st-axis">
            <div class="st-dot" :class="kindClass(stmt.source_kind)" />
            <span class="st-date mono">{{ shortDate(stmt.statement_date) }}</span>
          </div>
          <div class="st-side st-right">
            <div
              v-if="stmt.source_kind !== 'credit_card'"
              class="st-card"
              :class="kindClass(stmt.source_kind)"
            >
              <span class="st-card-kind">{{ kindLabel(stmt.source_kind) }}</span>
              <span class="st-card-source">{{ stmt.source }}</span>
              <span class="st-card-period mono">
                {{ shortDate(stmt.period_start) }} →
                {{ shortDate(stmt.period_end) }}
              </span>
              <span class="st-card-amount mono">
                {{ fmt(stmt.closing_balance, stmt.currency) }}
              </span>
              <span class="status-pill" :class="statusClass(stmt.status)">
                {{ (stmt.status || "imported").replace(/_/g, " ") }}
              </span>
              <a
                v-if="stmt.download_path"
                :href="stmt.download_path"
                target="_blank"
                rel="noopener"
                class="st-link"
                title="Download original PDF"
              >PDF</a>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.st-root {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  min-height: calc(100vh - 200px);
}

.st-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--border);
}

.st-title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
}

.st-sub {
  margin: 0.2rem 0 0;
  font-size: 0.78rem;
  color: var(--text-muted);
}

.st-totals {
  display: flex;
  gap: 1.25rem;
}

.st-total {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.st-total-label {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  font-weight: 600;
}

.st-total-amount {
  font-weight: 600;
  font-size: 0.95rem;
}

.st-empty {
  color: var(--text-muted);
  font-size: 0.9rem;
  padding: 1rem 0;
}

/* ── Timeline ──────────────────────────────────────────────────── */
.st-timeline {
  position: relative;
  display: flex;
  flex-direction: column;
}

/* Center spine — runs through the middle, separating card statements
   (left) from bank statements (right). */
.st-timeline::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 2px;
  background: var(--border);
  transform: translateX(-50%);
}

/* Each month is its own section with a guaranteed minimum vertical
   space — so a month with one statement still occupies a visible
   chunk of the timeline and elapsed time reads visually. */
.st-month-section {
  position: relative;
  min-height: 150px;
  padding: 0.5rem 0 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

/* Faint horizontal rule between months so empty months are visible
   as gaps rather than dead air. */
.st-month-section + .st-month-section {
  border-top: 1px dashed var(--border);
}

.st-row {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 120px 1fr;
  align-items: center;
  gap: 0.5rem;
  min-height: 36px;
}

.st-side {
  display: flex;
  min-width: 0;
}

.st-side.st-left {
  justify-content: flex-end;
}

.st-side.st-right {
  justify-content: flex-start;
}

.st-axis {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.15rem;
  position: relative;
  z-index: 2;
}

.st-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--text-muted);
  border: 2px solid var(--surface);
}

.st-axis .st-date {
  background: var(--bg);
  padding: 0 4px;
  white-space: nowrap;
}

.st-dot.kind-card {
  background: #8b5cf6;
}

.st-dot.kind-bank {
  background: #3b82f6;
}

.st-date {
  font-size: 0.72rem;
  color: var(--text-muted);
}

/* Month + today markers — span the full timeline width and sit on the
   center spine so they read as horizontal dividers between rows. */
.st-month-tick {
  position: relative;
  display: flex;
  justify-content: center;
  padding: 0.25rem 0;
  z-index: 2;
}

.st-month-label {
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  text-transform: uppercase;
  background: var(--bg);
  padding: 0 8px;
}

.st-today {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 0.4rem;
  padding: 0.25rem 0;
  z-index: 2;
}

.st-today::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  border-top: 1px dashed var(--danger);
  z-index: -1;
}

.st-today-word {
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--danger);
  background: var(--bg);
  padding: 0 6px;
}

.st-today-date {
  font-size: 0.7rem;
  color: var(--danger);
  font-family: var(--font-mono);
  background: var(--bg);
  padding: 0 6px;
}

/* ── Card ──────────────────────────────────────────────────────── */
/* Sized to match the vendor-timeline card scale: single horizontal row,
   ~0.78rem text, ~0.5rem padding, all key info on one line. */
.st-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-left-width: 3px;
  border-radius: var(--radius);
  padding: 0.35rem 0.55rem;
  display: flex;
  align-items: center;
  gap: 0.55rem;
  font-size: 0.78rem;
  min-width: 0;
}

.st-card.kind-card {
  border-left-color: #8b5cf6;
  background: #faf5ff;
}

.st-card.kind-bank {
  border-left-color: #3b82f6;
  background: #eff6ff;
}

.st-card-kind {
  font-size: 0.6rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 700;
  color: var(--text-muted);
  flex-shrink: 0;
}

.st-card.kind-card .st-card-kind {
  color: #6d28d9;
}

.st-card.kind-bank .st-card-kind {
  color: #1d4ed8;
}

.st-card-source {
  font-weight: 600;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.st-card-period {
  font-size: 0.72rem;
  color: var(--text-muted);
  flex-shrink: 0;
}

.st-card-amount {
  font-weight: 600;
  flex-shrink: 0;
}

.mono {
  font-family: var(--font-mono);
}

.st-link {
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--accent);
  text-decoration: none;
  flex-shrink: 0;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.st-link:hover {
  text-decoration: underline;
}

/* Status pills (reuse vendor-timeline patterns) */
.status-pill {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 10px;
  font-size: 0.6rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-family: var(--font-mono);
  flex-shrink: 0;
  white-space: nowrap;
}

.status-pill.status-imported {
  background: #eff6ff;
  color: #1d4ed8;
  border: 1px solid #bfdbfe;
}

.status-pill.status-partially_reconciled {
  background: #fffbeb;
  color: #b45309;
  border: 1px solid #fde68a;
}

.status-pill.status-reconciled {
  background: #f0fdf4;
  color: var(--ok);
  border: 1px solid #bbf7d0;
}

.status-pill.status-needs_attention {
  background: #fef2f2;
  color: var(--danger);
  border: 1px solid #fecaca;
}

@media (max-width: 720px) {
  .st-card {
    flex-wrap: wrap;
  }
  .st-card-period {
    flex-basis: 100%;
  }
}
</style>
