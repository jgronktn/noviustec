<script setup>
defineProps({
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

function fmtShort(amount, currency = "USD") {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

function invoiceStatusClass(status) {
  return `inv-${status}`; // inv-paid | inv-awaiting | inv-overdue | inv-written_off | inv-rejected
}

function statusLabel(status) {
  if (status === "overdue") return "OVERDUE";
  if (status === "awaiting") return "AWAITING";
  if (status === "paid") return "PAID";
  return status.toUpperCase();
}

function balanceTone(balance, overdueCount) {
  if (overdueCount > 0) return "balance-overdue";
  if (balance > 0) return "balance-awaiting";
  return "balance-clear";
}
</script>

<template>
  <div class="vendor-timeline">
    <!-- ── Header summary ──────────────────────────────────────────── -->
    <header class="t-summary">
      <div class="vendor-line">
        <h3 class="vendor-name">{{ data.vendor }}</h3>
        <span v-if="data.query !== data.vendor" class="match-note">
          matched “{{ data.query }}”
        </span>
      </div>

      <div class="totals-row">
        <div class="totals-tile">
          <span class="t-label">Total invoiced</span>
          <span class="t-value">{{ fmt(data.summary.total_invoiced) }}</span>
          <span class="t-hint">{{ data.summary.invoice_count }} invoice<span v-if="data.summary.invoice_count !== 1">s</span></span>
        </div>
        <div class="totals-tile">
          <span class="t-label">Total paid</span>
          <span class="t-value">{{ fmt(data.summary.total_paid) }}</span>
          <span class="t-hint">{{ data.summary.payment_count }} payment<span v-if="data.summary.payment_count !== 1">s</span></span>
        </div>
        <div
          class="totals-tile"
          :class="balanceTone(data.summary.outstanding_balance, data.summary.overdue_count)"
        >
          <span class="t-label">Outstanding</span>
          <span class="t-value">{{ fmt(data.summary.outstanding_balance) }}</span>
          <span class="t-hint">
            {{ data.summary.awaiting_count }} awaiting
            <template v-if="data.summary.overdue_count > 0">
              · {{ data.summary.overdue_count }} overdue
            </template>
          </span>
        </div>
      </div>

      <!-- Specific unpaid invoices, if any -->
      <div v-if="data.summary.outstanding_invoices.length > 0" class="outstanding-list">
        <span class="o-label">Unpaid:</span>
        <span
          v-for="o in data.summary.outstanding_invoices"
          :key="o.id"
          class="o-chip"
          :class="{ overdue: o.overdue }"
          :title="`${o.date} · ${o.days_outstanding}d outstanding`"
        >
          {{ o.reference_number || "(no ref)" }}
          · {{ fmtShort(o.amount) }}
          · {{ o.days_outstanding }}d
        </span>
      </div>
    </header>

    <!-- ── Empty state ─────────────────────────────────────────────── -->
    <div v-if="data.rows.length === 0" class="empty">
      No invoices or payments recorded for this vendor in this period.
    </div>

    <!-- ── Timeline ────────────────────────────────────────────────── -->
    <div v-else class="timeline">
      <div v-for="row in data.rows" :key="row.date" class="t-row">
        <!-- Invoices column (left) -->
        <div class="t-col t-col-inv">
          <article
            v-for="inv in row.invoices"
            :key="inv.id"
            class="evt evt-invoice"
            :class="invoiceStatusClass(inv.status)"
            :title="inv.description || ''"
          >
            <div class="evt-head">
              <span class="evt-kind">Invoice</span>
              <span class="evt-status">{{ statusLabel(inv.status) }}</span>
            </div>
            <div class="evt-amount">{{ fmt(inv.amount, inv.currency) }}</div>
            <div class="evt-meta">
              <span v-if="inv.reference_number" class="evt-ref">{{ inv.reference_number }}</span>
              <span
                v-if="inv.status === 'awaiting' || inv.status === 'overdue'"
                class="evt-age"
              >
                {{ inv.days_outstanding }}d outstanding
              </span>
              <span v-else-if="inv.paid_at" class="evt-age">
                paid {{ inv.paid_at }}
              </span>
            </div>
          </article>
        </div>

        <!-- Date axis (center) -->
        <div class="t-axis">
          <div class="axis-dot" />
          <div class="axis-date">{{ row.date }}</div>
        </div>

        <!-- Payments column (right) -->
        <div class="t-col t-col-pay">
          <article
            v-for="pay in row.payments"
            :key="pay.id"
            class="evt evt-payment"
            :title="pay.description || ''"
          >
            <div class="evt-head">
              <span class="evt-kind">Payment</span>
              <span v-if="pay.payment_source" class="evt-source">
                {{ pay.payment_source }}
              </span>
            </div>
            <div class="evt-amount">{{ fmt(pay.amount, pay.currency) }}</div>
            <div class="evt-meta">
              <span v-if="pay.reference_number" class="evt-ref">{{ pay.reference_number }}</span>
              <span v-if="pay.category" class="evt-cat">{{ pay.category }}</span>
            </div>
          </article>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vendor-timeline {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

/* ── Summary header ───────────────────────────────────────────────── */
.t-summary {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--border);
}

.vendor-line {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
}

.vendor-name {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text);
}

.match-note {
  font-size: 0.75rem;
  color: var(--text-muted);
  font-style: italic;
}

.totals-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.6rem;
}

.totals-tile {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.65rem 0.8rem;
  background: #fafaf5;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.totals-tile.balance-awaiting {
  background: #fffbeb;
  border-color: #fde68a;
}

.totals-tile.balance-overdue {
  background: #fef2f2;
  border-color: #fecaca;
}

.totals-tile.balance-clear {
  background: #f0fdf4;
  border-color: #bbf7d0;
}

.t-label {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  font-weight: 600;
}

.t-value {
  font-family: var(--font-mono);
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--text);
}

.t-hint {
  font-size: 0.72rem;
  color: var(--text-muted);
}

.outstanding-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.75rem;
}

.outstanding-list .o-label {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  font-weight: 600;
  margin-right: 0.3rem;
}

.o-chip {
  background: #fffbeb;
  border: 1px solid #fde68a;
  color: #92400e;
  padding: 2px 7px;
  border-radius: 10px;
  font-family: var(--font-mono);
  font-size: 0.7rem;
}

.o-chip.overdue {
  background: #fef2f2;
  border-color: #fecaca;
  color: #b91c1c;
  font-weight: 600;
}

.empty {
  color: var(--text-muted);
  font-size: 0.85rem;
  padding: 1rem 0;
}

/* ── Timeline body ────────────────────────────────────────────────── */
.timeline {
  display: flex;
  flex-direction: column;
}

.t-row {
  display: grid;
  grid-template-columns: 1fr 110px 1fr;
  align-items: stretch;
  position: relative;
  padding: 0.35rem 0;
}

/* Vertical line drawn through the axis column. */
.t-row::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: calc(50%);
  width: 2px;
  background: var(--border);
  transform: translateX(-50%);
  pointer-events: none;
}
.t-row:first-child::before {
  top: 0.4rem;
}
.t-row:last-child::before {
  bottom: calc(100% - 1.6rem);
}

.t-col {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.t-col-inv {
  align-items: flex-end;
  padding-right: 0.6rem;
}

.t-col-pay {
  align-items: flex-start;
  padding-left: 0.6rem;
}

.t-axis {
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
  z-index: 1;
  padding-top: 0.4rem;
}

.axis-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--surface);
  border: 2px solid var(--accent);
  margin-bottom: 0.25rem;
}

.axis-date {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--text-muted);
  white-space: nowrap;
  background: var(--bg);
  padding: 0 4px;
}

/* ── Event cards ──────────────────────────────────────────────────── */
.evt {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.55rem 0.7rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  max-width: 320px;
  min-width: 200px;
  width: 100%;
  transition: transform 0.08s ease-out, box-shadow 0.08s ease-out;
}

.evt:hover {
  transform: translateY(-1px);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.06);
}

/* Invoice color coding */
.evt-invoice.inv-paid {
  background: #f8f8f4;
  border-color: #e5e7eb;
  color: var(--text-muted);
}

.evt-invoice.inv-awaiting {
  background: #fffbeb;
  border-color: #fde68a;
}

.evt-invoice.inv-overdue {
  background: #fef2f2;
  border-color: #fecaca;
}

.evt-invoice.inv-written_off,
.evt-invoice.inv-rejected {
  background: #f8f8f4;
  border-color: #e5e7eb;
  opacity: 0.55;
}

/* Payment cards are neutral but clearly distinct */
.evt-payment {
  background: #eff6ff;
  border-color: #bfdbfe;
}

.evt-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 600;
  color: var(--text-muted);
}

.evt-kind {
  color: var(--text);
}

.evt-status {
  font-family: var(--font-mono);
}

.inv-paid .evt-status {
  color: var(--text-muted);
}
.inv-awaiting .evt-status {
  color: #b45309;
}
.inv-overdue .evt-status {
  color: #b91c1c;
}

.evt-source {
  font-family: var(--font-mono);
  color: #1d4ed8;
  font-weight: 500;
}

.evt-amount {
  font-family: var(--font-mono);
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text);
}

.inv-paid .evt-amount {
  color: var(--text-muted);
}

.evt-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.6rem;
  font-size: 0.7rem;
  color: var(--text-muted);
}

.evt-ref {
  font-family: var(--font-mono);
}

.evt-cat {
  font-style: italic;
}

@media (max-width: 720px) {
  .t-row {
    grid-template-columns: 1fr 80px 1fr;
  }
  .evt {
    min-width: 0;
  }
  .totals-row {
    grid-template-columns: 1fr;
  }
}
</style>
