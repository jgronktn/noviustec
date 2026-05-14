<script setup>
import { ref, onMounted, computed } from "vue";
import { listPending } from "../api.js";

const props = defineProps({ token: { type: String, required: true } });
const emit = defineEmits(["open"]);

const status = ref("pending");
const entries = ref([]);
const loading = ref(true);
const error = ref(null);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const data = await listPending(props.token, status.value);
    entries.value = data.entries;
  } catch (e) {
    error.value = e.status === 401 ? "Token rejected (401)" : e.message;
    if (e.status === 401) localStorage.removeItem("noviustec_token");
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function formatDate(iso) {
  if (!iso) return "";
  // Server stores as ISO timestamp at midnight UTC for the receipt date;
  // we just want YYYY-MM-DD.
  return new Date(iso).toISOString().slice(0, 10);
}

function formatTotal(amount, currency) {
  if (amount == null) return "—";
  return `${currency || ""} ${Number(amount).toFixed(2)}`.trim();
}

function confidenceClass(c) {
  if (c == null) return "";
  if (c >= 0.85) return "conf-high";
  if (c >= 0.5) return "conf-mid";
  return "conf-low";
}
</script>

<template>
  <section class="inbox">
    <div class="head">
      <h2>Inbox</h2>
      <div class="controls">
        <select v-model="status" @change="load">
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="all">All</option>
        </select>
        <button @click="load" :disabled="loading">
          {{ loading ? "Loading…" : "Refresh" }}
        </button>
      </div>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="!loading && entries.length === 0 && !error" class="empty">
      No {{ status }} entries.
    </div>

    <ul v-if="entries.length > 0" class="entries">
      <li
        v-for="e in entries"
        :key="e.id"
        @click="emit('open', e.id)"
        :class="{ resolved: e.status !== 'pending' }"
      >
        <div class="row1">
          <span class="vendor">{{ e.vendor || "(no vendor)" }}</span>
          <span class="total">{{ formatTotal(e.total, e.currency) }}</span>
        </div>
        <div class="row2">
          <span class="date">{{ formatDate(e.date) }}</span>
          <span class="cat">{{ e.suggested_category || "—" }}</span>
          <span
            v-if="e.confidence != null"
            class="conf"
            :class="confidenceClass(e.confidence)"
          >
            {{ Math.round(e.confidence * 100) }}%
          </span>
          <span v-if="e.reason" class="reason">{{ e.reason }}</span>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.inbox {
  max-width: 800px;
  margin: 0 auto;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
}

h2 {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 600;
}

.controls {
  display: flex;
  gap: 0.5rem;
}

.controls select {
  width: auto;
}

.error {
  background: #fef2f2;
  color: var(--danger);
  padding: 0.75rem 1rem;
  border-radius: var(--radius);
  border: 1px solid #fca5a5;
}

.empty {
  text-align: center;
  color: var(--text-muted);
  padding: 3rem 1rem;
}

.entries {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.entries li {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1rem;
  cursor: pointer;
  transition: background 0.1s ease, border-color 0.1s ease;
}

.entries li:hover {
  background: #f5f5f0;
  border-color: #d0d0c8;
}

.entries li.resolved {
  opacity: 0.6;
}

.row1 {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.vendor {
  font-weight: 600;
  font-size: 1.05rem;
}

.total {
  font-family: var(--font-mono);
  font-weight: 500;
}

.row2 {
  display: flex;
  gap: 1rem;
  font-size: 13px;
  color: var(--text-muted);
  margin-top: 0.25rem;
  flex-wrap: wrap;
}

.cat {
  color: var(--text);
}

.conf {
  font-family: var(--font-mono);
}

.conf-high {
  color: var(--ok);
}

.conf-mid {
  color: var(--warn);
}

.conf-low {
  color: var(--danger);
}

.reason {
  color: var(--warn);
  font-style: italic;
}
</style>
