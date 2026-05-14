<script setup>
const props = defineProps({
  props: { type: Object, required: true },
});

function fmt(amount, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function ageClass(days) {
  if (days == null) return "";
  if (days >= 60) return "age-overdue";
  if (days >= 30) return "age-late";
  return "age-fresh";
}
</script>

<template>
  <div class="awaiting-panel">
    <div class="summary">
      <span class="total">{{ fmt(props.total_outstanding) }}</span>
      <span class="meta">
        across {{ props.count }} unpaid invoice<span v-if="props.count !== 1">s</span>
      </span>
    </div>

    <div v-if="props.entries.length === 0" class="empty">
      No outstanding invoices. 🎉
    </div>
    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Vendor</th>
            <th>Invoice date</th>
            <th>Reference</th>
            <th class="num">Amount</th>
            <th class="num">Age</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in props.entries" :key="e.id">
            <td>{{ e.vendor }}</td>
            <td class="mono">{{ e.date }}</td>
            <td class="mono ref">{{ e.reference_number || "—" }}</td>
            <td class="num mono">{{ fmt(e.amount, e.currency) }}</td>
            <td class="num mono" :class="ageClass(e.days_outstanding)">
              {{ e.days_outstanding != null ? `${e.days_outstanding}d` : "—" }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.awaiting-panel {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.summary {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--border);
}

.summary .total {
  font-family: var(--font-mono);
  font-size: 1.4rem;
  font-weight: 600;
}

.summary .meta {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.empty {
  color: var(--text-muted);
  font-size: 0.85rem;
  padding: 0.5rem 0;
}

.table-wrap {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}

th {
  text-align: left;
  font-weight: 600;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  padding: 0.35rem 0.5rem 0.35rem 0;
  border-bottom: 1px solid var(--border);
}

td {
  padding: 0.4rem 0.5rem 0.4rem 0;
  border-bottom: 1px solid #efefea;
}

.num {
  text-align: right;
}

.mono {
  font-family: var(--font-mono);
}

.ref {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.age-overdue {
  color: var(--danger);
  font-weight: 600;
}

.age-late {
  color: var(--warn);
}

.age-fresh {
  color: var(--text-muted);
}
</style>
