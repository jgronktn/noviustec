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

function shortMonth(yyyyMm) {
  // yyyyMm = "2026-05" → "May 2026"
  const [y, m] = yyyyMm.split("-").map(Number);
  const names = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${names[m - 1]} ${y}`;
}

function invStatusClass(status) {
  return `inv-${status}`;
}

function kindLabel(kind) {
  if (kind === "invoice") return "Invoice";
  if (kind === "receipt") return "Receipt";
  if (kind === "payment") return "Payment";
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

// Interleave month boundary ticks between data rows so a small horizontal
// label divides activity by month. Rows are already newest-first; the
// first row of each month gets a tick rendered above it. We also slot a
// red TODAY marker at the boundary between future and past activity
// (which, for typical ledger data, means at the very top).
const todayIso = computed(
  () => props.data.summary?.as_of || new Date().toISOString().slice(0, 10),
);

const renderItems = computed(() => {
  const out = [];
  let lastMonth = null;
  let todayInserted = false;

  const insertToday = () => {
    if (todayInserted) return;
    out.push({ type: "today", date: todayIso.value, key: "today" });
    todayInserted = true;
  };

  for (const row of props.data.rows) {
    // The TODAY marker sits above the first row whose date is on or
    // before today — i.e. it separates future rows (above) from past
    // rows (below). For all-past data it lands at the very top.
    if (!todayInserted && row.date <= todayIso.value) {
      insertToday();
    }
    const month = (row.date || "").slice(0, 7);
    if (month && month !== lastMonth) {
      out.push({ type: "tick", month, key: `tick-${month}` });
      lastMonth = month;
    }
    out.push({ type: "row", row, key: `row-${row.date}` });
  }
  // All rows are future-dated: drop the marker at the bottom.
  if (!todayInserted && props.data.rows.length > 0) {
    insertToday();
  }
  return out;
});
</script>

<template>
  <div class="vt-root">
    <!-- Header is intentionally tiny: just the vendor name. No summary
         tiles — the timeline itself is the answer. -->
    <header class="vt-head">
      <h3 class="vt-vendor">{{ data.vendor }}</h3>
      <span v-if="data.query !== data.vendor" class="vt-match">
        matched “{{ data.query }}”
      </span>
    </header>

    <div v-if="data.rows.length === 0" class="vt-empty">
      No invoices or payments recorded for this vendor.
    </div>

    <div v-else class="vt-timeline">
      <template v-for="item in renderItems" :key="item.key">
        <!-- Today marker -->
        <div v-if="item.type === 'today'" class="vt-today">
          <span class="vt-today-bar" />
          <span class="vt-today-label">TODAY · {{ item.date }}</span>
          <span class="vt-today-bar" />
        </div>

        <!-- Month boundary tick -->
        <div v-else-if="item.type === 'tick'" class="vt-tick">
          <span class="vt-tick-bar" />
          <span class="vt-tick-label">{{ shortMonth(item.month) }}</span>
          <span class="vt-tick-bar" />
        </div>

        <!-- Data row: left = invoices/receipts, right = payments -->
        <div v-else class="vt-row">
          <div class="vt-side vt-left">
            <div
              v-for="ev in item.row.left"
              :key="ev.id"
              class="vt-card vt-card-left"
              :class="invStatusClass(ev.status)"
              :title="ev.description || ''"
            >
              <span class="vt-card-kind">{{ kindLabel(ev.kind) }}</span>
              <span v-if="ev.reference_number" class="vt-card-ref">
                {{ ev.reference_number }}
              </span>
              <span class="vt-card-amount">{{ fmt(ev.amount, ev.currency) }}</span>
              <span
                v-if="ev.status === 'awaiting' || ev.status === 'overdue'"
                class="vt-card-age"
              >
                {{ ev.days_outstanding }}d
                <template v-if="ev.status === 'overdue'">overdue</template>
              </span>
            </div>
          </div>

          <div class="vt-axis">
            <div class="vt-dot" />
            <span class="vt-date">{{ item.row.date }}</span>
          </div>

          <div class="vt-side vt-right">
            <div
              v-for="ev in item.row.right"
              :key="ev.id"
              class="vt-card vt-card-right"
              :title="ev.description || ''"
            >
              <span class="vt-card-kind">{{ kindLabel(ev.kind) }}</span>
              <span v-if="ev.payment_source" class="vt-card-source">
                {{ ev.payment_source }}
              </span>
              <span class="vt-card-amount">{{ fmt(ev.amount, ev.currency) }}</span>
              <span v-if="ev.category" class="vt-card-cat">{{ ev.category }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.vt-root {
  position: relative;
  display: flex;
  flex-direction: column;
  /* Take up the canvas — the dashboard pane scrolls when content overflows. */
  min-height: calc(100vh - 200px);
}

/* ── Header ────────────────────────────────────────────────────────── */
.vt-head {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  padding-bottom: 0.75rem;
  margin-bottom: 0.25rem;
  border-bottom: 1px solid var(--border);
}

.vt-vendor {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text);
}

.vt-match {
  font-size: 0.75rem;
  color: var(--text-muted);
  font-style: italic;
}

.vt-empty {
  color: var(--text-muted);
  font-size: 0.85rem;
  padding: 1rem 0;
}

/* ── Timeline ──────────────────────────────────────────────────────── */
.vt-timeline {
  position: relative;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
}

/* Continuous center line behind everything. */
.vt-timeline::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 2px;
  background: var(--border);
  transform: translateX(-50%);
  z-index: 0;
}

/* ── Month tick ────────────────────────────────────────────────────── */
.vt-tick {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0;
  position: relative;
  z-index: 1;
}

.vt-tick-bar {
  height: 1px;
  background: var(--border);
  width: 100%;
}

.vt-tick-label {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  background: var(--bg);
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--border);
  white-space: nowrap;
}

/* ── Today marker ──────────────────────────────────────────────────── */
.vt-today {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0;
  position: relative;
  z-index: 2;
}

.vt-today-bar {
  height: 2px;
  background: var(--danger);
  width: 100%;
}

.vt-today-label {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #fff;
  background: var(--danger);
  padding: 2px 10px;
  border-radius: 10px;
  border: 1px solid var(--danger);
  white-space: nowrap;
  box-shadow: 0 1px 3px rgba(220, 38, 38, 0.25);
}

/* ── Data row ──────────────────────────────────────────────────────── */
.vt-row {
  display: grid;
  grid-template-columns: 1fr 110px 1fr;
  align-items: center;
  padding: 0.3rem 0;
  position: relative;
  z-index: 1;
}

.vt-side {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  min-width: 0;
}

.vt-left {
  align-items: flex-end;
  padding-right: 0.6rem;
}

.vt-right {
  align-items: flex-start;
  padding-left: 0.6rem;
}

/* Date axis */
.vt-axis {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.2rem;
  position: relative;
  z-index: 2;
}

.vt-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--surface);
  border: 2px solid var(--accent);
}

.vt-date {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--text-muted);
  background: var(--bg);
  padding: 0 4px;
  white-space: nowrap;
}

/* ── Card (single line) ────────────────────────────────────────────── */
.vt-card {
  display: inline-flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.3rem 0.65rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 0.78rem;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
  transition: transform 0.08s ease-out, box-shadow 0.08s ease-out;
}

.vt-card:hover {
  transform: translateY(-1px);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.06);
}

/* Invoice / receipt color coding (subtle) */
.vt-card-left.inv-paid {
  background: #f8f8f4;
  border-color: #e5e7eb;
  color: var(--text-muted);
}
.vt-card-left.inv-awaiting {
  background: #fffbeb;
  border-color: #fde68a;
}
.vt-card-left.inv-overdue {
  background: #fef2f2;
  border-color: #fecaca;
  color: #b91c1c;
}
.vt-card-left.inv-written_off,
.vt-card-left.inv-rejected {
  background: #f8f8f4;
  border-color: #e5e7eb;
  opacity: 0.55;
}

.vt-card-right {
  background: #eff6ff;
  border-color: #bfdbfe;
}

.vt-card-kind {
  font-size: 0.6rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 700;
  color: var(--text-muted);
  flex-shrink: 0;
}

.vt-card-ref {
  font-family: var(--font-mono);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.vt-card-amount {
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--text);
  flex-shrink: 0;
}

.inv-paid .vt-card-amount {
  color: var(--text-muted);
}

.vt-card-age {
  font-size: 0.7rem;
  color: var(--warn);
  flex-shrink: 0;
}

.inv-overdue .vt-card-age {
  color: #b91c1c;
  font-weight: 600;
}

.vt-card-source {
  font-family: var(--font-mono);
  color: #1d4ed8;
  font-weight: 500;
  flex-shrink: 0;
}

.vt-card-cat {
  font-style: italic;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

@media (max-width: 720px) {
  .vt-row {
    grid-template-columns: 1fr 80px 1fr;
  }
  .vt-card {
    font-size: 0.72rem;
    padding: 0.25rem 0.5rem;
    gap: 0.35rem;
  }
}
</style>
