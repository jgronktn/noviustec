<script setup>
import { computed, ref, inject } from "vue";

const props = defineProps({
  data: { type: Object, required: true },
});

// Provided by App.vue. Returns a Promise<boolean> — true on submit,
// false on cancel. Optional so the component still renders fine in
// contexts where the dialog isn't mounted.
const openPaymentDialog = inject("openPaymentDialog", null);

// Locally-recorded paid awaitings so the card visually flips to "paid"
// after the dialog resolves — the panel's incoming data is a snapshot
// and would otherwise stay stale until the user re-asks.
const locallyPaid = ref(new Set());

function isClickable(ev) {
  return (
    openPaymentDialog != null &&
    ev.source === "awaiting" &&
    !locallyPaid.value.has(ev.id) &&
    (ev.status === "awaiting" || ev.status === "overdue")
  );
}

function effectiveStatus(ev) {
  return locallyPaid.value.has(ev.id) ? "paid" : ev.status;
}

async function handleCardClick(ev) {
  if (!isClickable(ev)) return;
  const paid = await openPaymentDialog({
    id: ev.id,
    vendor: ev.vendor,
    amount: ev.amount,
    currency: ev.currency,
    reference_number: ev.reference_number,
    date: ev.date,
  });
  if (paid) {
    const next = new Set(locallyPaid.value);
    next.add(ev.id);
    locallyPaid.value = next;
  }
}

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

// Group rows by month so each month becomes a wrapped section. The
// section gets a CSS `min-height` to enforce at least 150px of vertical
// distance between consecutive month tags, regardless of how few rows
// the month contains. Within a section we also slot in the red TODAY
// marker at the boundary between future and past activity.
const monthGroups = computed(() => {
  const groups = [];
  let current = null;
  let todayInserted = false;

  const ensureGroup = (month) => {
    if (!current || current.month !== month) {
      current = { month, key: `m-${month}`, items: [] };
      groups.push(current);
    }
    return current;
  };

  for (const row of props.data.rows) {
    const month = (row.date || "").slice(0, 7);
    if (!month) continue;
    const group = ensureGroup(month);
    if (!todayInserted && row.date <= todayIso.value) {
      group.items.push({ type: "today", date: todayIso.value, key: "today" });
      todayInserted = true;
    }
    group.items.push({ type: "row", row, key: `row-${row.date}` });
  }

  // All rows are future-dated → drop the TODAY marker at the bottom of
  // the last (oldest = earliest in the future) group.
  if (!todayInserted && groups.length > 0) {
    groups[groups.length - 1].items.push({
      type: "today",
      date: todayIso.value,
      key: "today",
    });
  }
  return groups;
});
</script>

<template>
  <div class="vt-root">
    <!-- Header is intentionally tiny. Single-vendor mode shows the
         canonical name; global mode shows 'All activity' plus a count.
         No summary tiles — the timeline itself is the answer. -->
    <header class="vt-head">
      <h3 v-if="data.is_global" class="vt-vendor">All activity</h3>
      <h3 v-else class="vt-vendor">{{ data.vendor }}</h3>
      <span v-if="data.is_global" class="vt-match">
        {{ data.summary.distinct_vendors }} vendor<span v-if="data.summary.distinct_vendors !== 1">s</span>
        · {{ data.summary.invoice_count + data.summary.payment_count }} event<span v-if="data.summary.invoice_count + data.summary.payment_count !== 1">s</span>
      </span>
      <span v-else-if="data.query !== data.vendor" class="vt-match">
        matched “{{ data.query }}”
      </span>
    </header>

    <div v-if="data.rows.length === 0" class="vt-empty">
      No invoices or payments recorded for this vendor.
    </div>

    <div v-else class="vt-timeline">
      <!-- Per-side running totals, pinned above the top month tag. -->
      <div class="vt-totals">
        <div class="vt-side vt-left">
          <div class="vt-total vt-total-left">
            <span class="vt-total-label">Invoices &amp; Receipts</span>
            <span class="vt-total-amount">{{ fmt(data.summary.total_left) }}</span>
          </div>
        </div>
        <div class="vt-axis vt-axis-spacer" />
        <div class="vt-side vt-right">
          <div class="vt-total vt-total-right">
            <span class="vt-total-label">Payments</span>
            <span class="vt-total-amount">{{ fmt(data.summary.total_right) }}</span>
          </div>
        </div>
      </div>

      <section
        v-for="group in monthGroups"
        :key="group.key"
        class="vt-month"
      >
        <!-- Month label sits at the top of its section -->
        <div class="vt-tick">
          <span class="vt-tick-bar" />
          <span class="vt-tick-label">{{ shortMonth(group.month) }}</span>
          <span class="vt-tick-bar" />
        </div>

        <template v-for="item in group.items" :key="item.key">
          <!-- Today marker: solid red dot on the axis, label to the right -->
          <div v-if="item.type === 'today'" class="vt-today">
            <div class="vt-side vt-left" />
            <div class="vt-axis">
              <div class="vt-today-dot" />
            </div>
            <div class="vt-side vt-right">
              <span class="vt-today-label">
                <span class="vt-today-word">TODAY</span>
                <span class="vt-today-date">{{ item.date }}</span>
              </span>
            </div>
          </div>

          <!-- Data row: left = invoices/receipts, right = payments -->
          <div v-else class="vt-row">
          <div class="vt-side vt-left">
            <div
              v-for="ev in item.row.left"
              :key="ev.id"
              class="vt-card vt-card-left"
              :class="[
                invStatusClass(effectiveStatus(ev)),
                { 'vt-card-clickable': isClickable(ev) },
              ]"
              :title="isClickable(ev) ? 'Click to record payment' : (ev.description || '')"
              @click="handleCardClick(ev)"
            >
              <span class="vt-card-kind">{{ kindLabel(ev.kind) }}</span>
              <span v-if="data.is_global" class="vt-card-vendor">{{ ev.vendor }}</span>
              <span v-if="ev.reference_number" class="vt-card-ref">
                {{ ev.reference_number }}
              </span>
              <span class="vt-card-amount">{{ fmt(ev.amount, ev.currency) }}</span>
              <span
                v-if="effectiveStatus(ev) === 'awaiting' || effectiveStatus(ev) === 'overdue'"
                class="vt-card-age"
              >
                {{ ev.days_outstanding }}d
                <template v-if="effectiveStatus(ev) === 'overdue'">overdue</template>
              </span>
              <span v-if="locallyPaid.has(ev.id)" class="vt-card-just-paid">
                ✓ Paid
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
              <span v-if="data.is_global" class="vt-card-vendor">{{ ev.vendor }}</span>
              <span v-if="ev.payment_source" class="vt-card-source">
                {{ ev.payment_source }}
              </span>
              <span class="vt-card-amount">{{ fmt(ev.amount, ev.currency) }}</span>
              <span v-if="ev.category" class="vt-card-cat">{{ ev.category }}</span>
            </div>
          </div>
        </div>
        </template>
      </section>
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

/* ── Totals strip (pinned above the first month section) ──────────────
   Two side-aligned cards reporting the literal sum of every card on
   each side of the line. */
.vt-totals {
  display: grid;
  grid-template-columns: 1fr 110px 1fr;
  align-items: stretch;
  padding-bottom: 0.85rem;
  margin-bottom: 0.35rem;
  border-bottom: 1px dashed var(--border);
}

.vt-axis-spacer {
  /* center column is intentionally empty; the line still draws through */
}

.vt-total {
  display: inline-flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0.5rem 0.85rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.vt-total-left {
  /* match the left-column right-alignment of left-side cards */
  align-self: flex-end;
}

.vt-total-right {
  align-self: flex-start;
}

.vt-total-label {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 700;
  color: var(--text-muted);
}

.vt-total-amount {
  font-family: var(--font-mono);
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--text);
}

@media (max-width: 720px) {
  .vt-totals {
    grid-template-columns: 1fr 80px 1fr;
  }
  .vt-total-amount {
    font-size: 1rem;
  }
}

/* ── Month section ────────────────────────────────────────────────────
   Each month is wrapped in a section so we can guarantee at least 150px
   of vertical distance between consecutive month tags, regardless of
   how few rows the month contains. The center line sits behind via the
   parent's ::before, so spacing the sections just spaces the ticks. */
.vt-month {
  display: flex;
  flex-direction: column;
  min-height: 150px;
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
  grid-template-columns: 1fr 110px 1fr;
  align-items: center;
  padding: 0.4rem 0;
  position: relative;
  z-index: 2;
}

/* Solid red dot on the axis — mirrors the .vt-dot shape but fully filled. */
.vt-today-dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--danger);
  border: 2px solid var(--danger);
  box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.18);
}

.vt-today-label {
  display: inline-flex;
  align-items: baseline;
  gap: 0.45rem;
  padding-left: 0.6rem; /* aligns with the side gutter spacing */
  white-space: nowrap;
}

.vt-today-word {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--danger);
}

.vt-today-date {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--text-muted);
}

@media (max-width: 720px) {
  .vt-today {
    grid-template-columns: 1fr 80px 1fr;
  }
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

.vt-card-clickable {
  cursor: pointer;
}

.vt-card-clickable:hover {
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
  border-color: var(--accent);
}

.vt-card-just-paid {
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--ok);
  flex-shrink: 0;
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

.vt-card-vendor {
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  max-width: 160px;
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
