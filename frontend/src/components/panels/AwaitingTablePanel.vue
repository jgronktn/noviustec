<script setup>
import { ref, computed, inject } from "vue";
import {
  recordPayment,
  getCategories,
  getPaymentSources,
} from "../../api.js";

const props = defineProps({
  data: { type: Object, required: true },
});

const token = inject("apiToken");

// Per-row local state. Keyed by awaiting row id.
//   open    → form expanded
//   paid    → after a successful payment record
//   error   → submission error message
const rowState = ref(new Map());

function getState(id) {
  return rowState.value.get(id) ?? { open: false, paid: false, error: null };
}

function setState(id, patch) {
  const next = new Map(rowState.value);
  next.set(id, { ...getState(id), ...patch });
  rowState.value = next;
}

// Form fields per row. We don't bother sharing state — opening one
// closes the previous.
const formState = ref(new Map());
function getForm(id, awaiting) {
  if (!formState.value.has(id)) {
    const today = new Date().toISOString().slice(0, 10);
    formState.value.set(id, {
      date: today,
      category: "",
      payment_source: "",
      reference_number: "",
      reference_kind: "confirmation",
      notes: "",
    });
  }
  return formState.value.get(id);
}

const REFERENCE_KINDS = [
  { value: "confirmation", label: "Confirmation #" },
  { value: "transaction", label: "Check / Transaction #" },
  { value: "receipt", label: "Receipt #" },
  { value: "invoice", label: "Invoice #" },
  { value: "order", label: "Order #" },
  { value: "other", label: "Other" },
];

// Lazily fetch chart-of-accounts / payment-source dropdowns the first
// time the user opens any form on this panel.
const categories = ref([]);
const paymentSources = ref([]);
const loadingLookups = ref(false);
const lookupsLoaded = ref(false);

async function ensureLookups() {
  if (lookupsLoaded.value || loadingLookups.value) return;
  loadingLookups.value = true;
  try {
    const [c, s] = await Promise.all([
      getCategories(token.value),
      getPaymentSources(token.value),
    ]);
    categories.value = c.categories ?? [];
    paymentSources.value = s.sources ?? [];
    lookupsLoaded.value = true;
  } catch {
    /* surfaced inline if the user tries to submit */
  } finally {
    loadingLookups.value = false;
  }
}

async function toggleForm(id) {
  const cur = getState(id);
  if (cur.open) {
    setState(id, { open: false, error: null });
    return;
  }
  // Close any other open forms — keeps the panel tidy.
  for (const [otherId, otherState] of rowState.value.entries()) {
    if (otherId !== id && otherState.open) {
      setState(otherId, { open: false });
    }
  }
  setState(id, { open: true, error: null });
  ensureLookups();
}

async function submit(awaiting) {
  const id = awaiting.id;
  const form = getForm(id);
  setState(id, { error: null });

  if (!form.date) {
    setState(id, { error: "Payment date is required." });
    return;
  }
  if (!form.category) {
    setState(id, { error: "Category is required." });
    return;
  }
  if (!form.payment_source) {
    setState(id, { error: "Payment source is required." });
    return;
  }

  try {
    await recordPayment(token.value, id, {
      date: form.date,
      category: form.category,
      payment_source: form.payment_source,
      reference_number: form.reference_number || null,
      reference_kind: form.reference_number ? form.reference_kind : null,
      notes: form.notes || "",
    });
    setState(id, { open: false, paid: true });
  } catch (e) {
    setState(id, { error: e.message || "Failed to record payment." });
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

function ageClass(days) {
  if (days == null) return "";
  if (days >= 60) return "age-overdue";
  if (days >= 30) return "age-late";
  return "age-fresh";
}

// Hide rows the user has already paid in this session from the total +
// count at the top of the panel.
const unpaidEntries = computed(() =>
  props.data.entries.filter((e) => !getState(e.id).paid),
);
const unpaidCount = computed(() => unpaidEntries.value.length);
const unpaidTotal = computed(() =>
  unpaidEntries.value.reduce((s, e) => s + (Number(e.amount) || 0), 0),
);
</script>

<template>
  <div class="awaiting-panel">
    <div class="summary">
      <span class="total">{{ fmt(unpaidTotal) }}</span>
      <span class="meta">
        across {{ unpaidCount }} unpaid invoice<span v-if="unpaidCount !== 1">s</span>
      </span>
    </div>

    <div v-if="data.entries.length === 0" class="empty">
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
            <th class="action"></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="e in data.entries" :key="e.id">
            <tr :class="{ paid: getState(e.id).paid }">
              <td>{{ e.vendor }}</td>
              <td class="mono">{{ e.date }}</td>
              <td class="mono ref">{{ e.reference_number || "—" }}</td>
              <td class="num mono">{{ fmt(e.amount, e.currency) }}</td>
              <td class="num mono" :class="ageClass(e.days_outstanding)">
                {{ e.days_outstanding != null ? `${e.days_outstanding}d` : "—" }}
              </td>
              <td class="action">
                <span v-if="getState(e.id).paid" class="paid-pill">✓ Paid</span>
                <button
                  v-else
                  class="ghost"
                  @click="toggleForm(e.id)"
                >
                  {{ getState(e.id).open ? "Cancel" : "Record payment" }}
                </button>
              </td>
            </tr>

            <!-- Inline payment form, expanded under the row -->
            <tr v-if="getState(e.id).open" class="form-row">
              <td colspan="6">
                <form class="pay-form" @submit.prevent="submit(e)">
                  <div class="grid">
                    <label>
                      <span>Payment date</span>
                      <input type="date" v-model="getForm(e.id, e).date" required />
                    </label>
                    <label>
                      <span>Category</span>
                      <select v-model="getForm(e.id, e).category" required>
                        <option value="" disabled>{{ loadingLookups ? "Loading…" : "Pick one" }}</option>
                        <option v-for="c in categories" :key="c.name" :value="c.name">
                          {{ c.name }}
                        </option>
                      </select>
                    </label>
                    <label>
                      <span>Payment source</span>
                      <select v-model="getForm(e.id, e).payment_source" required>
                        <option value="" disabled>{{ loadingLookups ? "Loading…" : "Pick one" }}</option>
                        <option v-for="s in paymentSources" :key="s.name" :value="s.name">
                          {{ s.name }}<template v-if="s.last4"> · ••{{ s.last4 }}</template>
                        </option>
                      </select>
                    </label>
                    <label class="ref-number">
                      <span>Reference number</span>
                      <input
                        type="text"
                        v-model="getForm(e.id, e).reference_number"
                        placeholder="check # / confirmation / last 4"
                      />
                    </label>
                    <label class="ref-kind">
                      <span>Reference type</span>
                      <select v-model="getForm(e.id, e).reference_kind">
                        <option
                          v-for="k in REFERENCE_KINDS"
                          :key="k.value"
                          :value="k.value"
                        >{{ k.label }}</option>
                      </select>
                    </label>
                  </div>
                  <label class="notes">
                    <span>Notes (optional)</span>
                    <input
                      type="text"
                      v-model="getForm(e.id, e).notes"
                      placeholder="e.g. mailed check, manual entry"
                    />
                  </label>

                  <p v-if="getState(e.id).error" class="form-error">
                    {{ getState(e.id).error }}
                  </p>

                  <div class="form-actions">
                    <span class="form-summary">
                      Book {{ fmt(e.amount, e.currency) }} to {{ e.vendor }}
                    </span>
                    <button type="button" class="ghost" @click="toggleForm(e.id)">
                      Cancel
                    </button>
                    <button type="submit" class="primary">Record payment</button>
                  </div>
                </form>
              </td>
            </tr>
          </template>
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
  vertical-align: middle;
}

tr.paid td {
  opacity: 0.55;
}

.num {
  text-align: right;
}

.action {
  text-align: right;
  white-space: nowrap;
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

button.ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text);
  font-size: 0.75rem;
  padding: 0.25rem 0.6rem;
  border-radius: 4px;
  cursor: pointer;
}

button.ghost:hover {
  background: #f5f5f0;
}

button.primary {
  font-size: 0.8rem;
  padding: 0.35rem 0.85rem;
}

.paid-pill {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--ok);
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
}

/* ── Inline form ───────────────────────────────────────────────────── */
.form-row td {
  background: #fafaf5;
  padding: 0.65rem 0.85rem 0.85rem;
  border-bottom: 1px solid var(--border);
}

.pay-form {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.pay-form .grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.55rem 0.65rem;
}

.pay-form label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.72rem;
  color: var(--text-muted);
}

.pay-form label span {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 0.65rem;
}

.pay-form input,
.pay-form select {
  font-size: 0.85rem;
  padding: 0.3rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
}

.pay-form .notes {
  /* full-width single-line input below the grid */
}

.form-error {
  margin: 0;
  font-size: 0.8rem;
  color: var(--danger);
  padding: 0.35rem 0.55rem;
  background: #fef2f2;
  border: 1px solid #fca5a5;
  border-radius: 4px;
}

.form-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  justify-content: flex-end;
}

.form-summary {
  margin-right: auto;
  font-size: 0.75rem;
  color: var(--text-muted);
  font-style: italic;
}
</style>
