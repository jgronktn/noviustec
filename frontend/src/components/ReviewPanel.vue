<script setup>
import { ref, computed, onMounted } from "vue";
import {
  getPending,
  getCategories,
  getPaymentSources,
  approvePending,
  rejectPending,
  openPendingDocument,
} from "../api.js";

const REFERENCE_KINDS = [
  { value: "", label: "(none)" },
  { value: "invoice", label: "Invoice" },
  { value: "receipt", label: "Receipt" },
  { value: "order", label: "Order" },
  { value: "transaction", label: "Transaction" },
  { value: "confirmation", label: "Confirmation" },
  { value: "other", label: "Other" },
];

const props = defineProps({
  token: { type: String, required: true },
  id: { type: String, required: true },
});
const emit = defineEmits(["back"]);

const detail = ref(null);
const categories = ref([]);
const sources = ref([]);
const loading = ref(true);
const submitting = ref(false);
const error = ref(null);
const rejectReason = ref("");

const form = ref({
  vendor: "",
  date: "",
  total: 0,
  currency: "USD",
  category: "",
  payment_source: null,
  reference_number: "",
  reference_kind: "",
  description: "",
  notes: "",
});

const docOpening = ref(false);
const docError = ref(null);

async function viewDocument() {
  docOpening.value = true;
  docError.value = null;
  try {
    await openPendingDocument(props.token, props.id);
  } catch (e) {
    docError.value = e.message;
  } finally {
    docOpening.value = false;
  }
}

// The /api/pending/:id payload is { ...row, proposal }. The `proposal`
// field is the full parseReceipt result; the LLM's structured output is
// nested at proposal.proposal. Aliased here for the template.
const llmOutput = computed(() => detail.value?.proposal?.proposal ?? null);
const usage = computed(() => detail.value?.proposal?.usage ?? null);

onMounted(async () => {
  try {
    const [d, c, s] = await Promise.all([
      getPending(props.token, props.id),
      getCategories(props.token),
      getPaymentSources(props.token),
    ]);
    detail.value = d;
    categories.value = c.categories;
    sources.value = s.sources;

    // Pre-fill the form from the proposal where possible, with the
    // pending row's denormalized fields as a fallback.
    const p = d.proposal?.proposal;
    form.value = {
      vendor: p?.vendor?.name || d.vendor || "",
      date: p?.date || (d.date ? new Date(d.date).toISOString().slice(0, 10) : ""),
      total: p?.total?.amount ?? d.total ?? 0,
      currency: p?.total?.currency || d.currency || "USD",
      category: p?.suggested_category || d.suggested_category || "",
      payment_source: p?.suggested_payment_source || d.suggested_source || null,
      reference_number: p?.reference_number?.value || d.reference_number || "",
      reference_kind: p?.reference_number?.kind || d.reference_kind || "",
      description: "",
      notes: "",
    };
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
});

async function approve() {
  submitting.value = true;
  error.value = null;
  try {
    const body = {
      vendor: form.value.vendor.trim(),
      date: form.value.date,
      total: Number(form.value.total),
      currency: form.value.currency || "USD",
      category: form.value.category,
      payment_source: form.value.payment_source || null,
      reference_number: form.value.reference_number?.trim() || null,
      reference_kind: form.value.reference_kind || null,
      description: form.value.description || "",
      notes: form.value.notes || "",
    };
    await approvePending(props.token, props.id, body);
    emit("back");
  } catch (e) {
    error.value = e.message;
    submitting.value = false;
  }
}

async function reject() {
  if (!confirm("Reject this receipt? It won't be added to the ledger.")) return;
  submitting.value = true;
  error.value = null;
  try {
    await rejectPending(props.token, props.id, {
      reason: rejectReason.value || "manual",
      notes: form.value.notes || "",
    });
    emit("back");
  } catch (e) {
    error.value = e.message;
    submitting.value = false;
  }
}

function formatPercent(c) {
  return c != null ? `${Math.round(c * 100)}%` : "—";
}
</script>

<template>
  <section class="review">
    <button class="back ghost" @click="emit('back')">← Back to inbox</button>

    <div v-if="loading" class="loading">Loading…</div>

    <div v-else-if="!detail" class="error">Not found.</div>

    <div v-else class="layout">
      <!-- Editable form -->
      <div class="card form-card">
        <h2>Review &amp; approve</h2>

        <p v-if="error" class="error">{{ error }}</p>

        <div class="grid">
          <div class="field">
            <label>Vendor</label>
            <input v-model="form.vendor" />
          </div>

          <div class="field">
            <label>Date</label>
            <input v-model="form.date" type="date" />
          </div>

          <div class="field">
            <label>Total</label>
            <input v-model.number="form.total" type="number" step="0.01" />
          </div>

          <div class="field">
            <label>Currency</label>
            <input v-model="form.currency" />
          </div>

          <div class="field span2">
            <label>Category</label>
            <select v-model="form.category">
              <option value="">(none)</option>
              <option v-for="c in categories" :key="c.name" :value="c.name">
                {{ c.name }}
              </option>
            </select>
          </div>

          <div class="field span2">
            <label>Payment source</label>
            <select v-model="form.payment_source">
              <option :value="null">(none)</option>
              <option v-for="s in sources" :key="s.name" :value="s.name">
                {{ s.name }}{{ s.last4 ? ` ••${s.last4}` : "" }}
              </option>
            </select>
            <p v-if="sources.length === 0" class="hint">
              No payment sources yet — add them in
              <code>backend/companies/default/ledger.xlsx</code> under the
              Sources sheet.
            </p>
          </div>

          <div class="field">
            <label>Reference #</label>
            <input
              v-model="form.reference_number"
              placeholder="invoice / receipt / order number"
            />
          </div>

          <div class="field">
            <label>Reference kind</label>
            <select v-model="form.reference_kind">
              <option
                v-for="k in REFERENCE_KINDS"
                :key="k.value"
                :value="k.value"
              >
                {{ k.label }}
              </option>
            </select>
          </div>

          <div class="field span2">
            <label>Description</label>
            <input
              v-model="form.description"
              placeholder="optional — e.g. 'Lunch with client'"
            />
          </div>

          <div class="field span2">
            <label>Notes</label>
            <textarea v-model="form.notes" rows="2" placeholder="optional" />
          </div>
        </div>

        <div class="actions">
          <input
            v-model="rejectReason"
            placeholder="reject reason (optional)"
            class="reject-reason"
          />
          <button @click="reject" :disabled="submitting" class="danger">
            Reject
          </button>
          <button
            @click="approve"
            :disabled="submitting || !form.vendor || !form.date || !form.category"
            class="primary"
          >
            {{ submitting ? "Saving…" : "Approve → ledger" }}
          </button>
        </div>
      </div>

      <!-- Proposal context (read-only) -->
      <aside class="card context">
        <h3>Parser proposal</h3>
        <dl>
          <dt>Status</dt>
          <dd>{{ detail.status }}<span v-if="detail.reason"> ({{ detail.reason }})</span></dd>
          <dt>Confidence</dt>
          <dd>{{ formatPercent(llmOutput?.confidence) }}</dd>
          <dt v-if="llmOutput?.reference_number">Reference</dt>
          <dd v-if="llmOutput?.reference_number" class="mono">
            {{ llmOutput.reference_number.value }}
            <span class="ref-kind">({{ llmOutput.reference_number.kind }})</span>
          </dd>
          <dt>Source email</dt>
          <dd class="mono">{{ detail.source_file }}</dd>
        </dl>

        <div class="doc-action">
          <button @click="viewDocument" :disabled="docOpening" class="ghost-block">
            {{ docOpening ? "Opening…" : "📎 View attached document" }}
          </button>
          <p v-if="docError" class="error small">{{ docError }}</p>
        </div>

        <h4 v-if="llmOutput?.line_items?.length">Line items</h4>
        <ul v-if="llmOutput?.line_items?.length" class="line-items">
          <li v-for="(li, i) in llmOutput.line_items" :key="i">
            <span>{{ li.description }}</span>
            <span class="mono">{{ Number(li.amount).toFixed(2) }}</span>
          </li>
        </ul>

        <h4 v-if="llmOutput?.notes">Model notes</h4>
        <p v-if="llmOutput?.notes" class="notes">{{ llmOutput.notes }}</p>

        <h4 v-if="usage">Token usage</h4>
        <dl v-if="usage" class="mono small">
          <dt>input</dt>
          <dd>{{ usage.input_tokens }}</dd>
          <dt>output</dt>
          <dd>{{ usage.output_tokens }}</dd>
          <dt v-if="usage.cache_read_input_tokens">cache hit</dt>
          <dd v-if="usage.cache_read_input_tokens">
            {{ usage.cache_read_input_tokens }}
          </dd>
        </dl>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.review {
  max-width: 1000px;
  margin: 0 auto;
}

.back {
  margin-bottom: 1rem;
}

.ghost {
  background: transparent;
  border-color: transparent;
  color: var(--text-muted);
}

.ghost:hover {
  background: #f5f5f0;
  color: var(--text);
}

.loading {
  color: var(--text-muted);
  padding: 2rem;
  text-align: center;
}

.layout {
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 1.5rem;
}

@media (max-width: 800px) {
  .layout {
    grid-template-columns: 1fr;
  }
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.5rem;
  box-shadow: var(--shadow);
}

.form-card h2 {
  margin: 0 0 1rem;
  font-size: 1.25rem;
  font-weight: 600;
}

.error {
  background: #fef2f2;
  color: var(--danger);
  padding: 0.75rem 1rem;
  border-radius: var(--radius);
  border: 1px solid #fca5a5;
  margin-bottom: 1rem;
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.field.span2 {
  grid-column: span 2;
}

.hint {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0.25rem 0 0;
}

.actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 1.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
}

.reject-reason {
  flex: 1;
}

.context h3,
.context h4 {
  margin: 0 0 0.5rem;
  font-size: 0.95rem;
  font-weight: 600;
}

.context h4 {
  margin-top: 1rem;
  font-size: 0.85rem;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.context dl {
  margin: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25rem 0.75rem;
  font-size: 13px;
}

.context dl.small {
  font-size: 12px;
}

.context dt {
  color: var(--text-muted);
}

.context dd {
  margin: 0;
}

.mono {
  font-family: var(--font-mono);
  font-size: 12px;
  word-break: break-all;
}

.ref-kind {
  color: var(--text-muted);
  font-style: italic;
  margin-left: 0.25rem;
}

.doc-action {
  margin-top: 1rem;
}

.ghost-block {
  width: 100%;
  background: transparent;
  border: 1px dashed var(--border);
  color: var(--text-muted);
}

.ghost-block:hover {
  background: #f5f5f0;
  color: var(--text);
  border-style: solid;
}

.error.small {
  margin-top: 0.5rem;
  font-size: 12px;
}

.line-items {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 13px;
}

.line-items li {
  display: flex;
  justify-content: space-between;
  padding: 0.25rem 0;
  border-bottom: 1px dashed var(--border);
}

.line-items li:last-child {
  border-bottom: none;
}

.notes {
  font-size: 13px;
  color: var(--text);
  margin: 0;
  white-space: pre-wrap;
}
</style>
