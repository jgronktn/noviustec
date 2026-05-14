<script setup>
import { ref } from "vue";
import { uploadReceipt } from "../api.js";

const props = defineProps({ token: { type: String, required: true } });
const emit = defineEmits(["uploaded"]);

const SUPPORTED_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];
const MAX_BYTES = 5 * 1024 * 1024;

const dragOver = ref(false);
const file = ref(null);
const description = ref("");
const uploading = ref(false);
const error = ref(null);
const lastResult = ref(null);
const fileInput = ref(null);

function onDragOver(e) {
  e.preventDefault();
  dragOver.value = true;
}

function onDragLeave() {
  dragOver.value = false;
}

function onDrop(e) {
  e.preventDefault();
  dragOver.value = false;
  const f = e.dataTransfer?.files?.[0];
  if (f) selectFile(f);
}

function onPickClick() {
  fileInput.value?.click();
}

function onPickChange(e) {
  const f = e.target.files?.[0];
  if (f) selectFile(f);
  e.target.value = ""; // allow re-picking the same file
}

function selectFile(f) {
  error.value = null;
  lastResult.value = null;
  if (!SUPPORTED_TYPES.includes(f.type)) {
    error.value = `Unsupported type: ${f.type || "(unknown)"}. PDF or image only.`;
    return;
  }
  if (f.size > MAX_BYTES) {
    error.value = `Too large: ${formatSize(f.size)}. Max ${formatSize(MAX_BYTES)}.`;
    return;
  }
  file.value = f;
}

function clearFile() {
  file.value = null;
  description.value = "";
  error.value = null;
}

async function upload() {
  if (!file.value) return;
  uploading.value = true;
  error.value = null;
  lastResult.value = null;
  try {
    const res = await uploadReceipt(props.token, {
      file: file.value,
      description: description.value,
    });
    lastResult.value = res;
    file.value = null;
    description.value = "";
    emit("uploaded", res);
  } catch (e) {
    error.value = e.message;
  } finally {
    uploading.value = false;
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
  <div class="upload-card">
    <div
      class="drop-zone"
      :class="{ active: dragOver, busy: uploading, 'has-file': file }"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
      @click="!file && !uploading && onPickClick()"
    >
      <input
        ref="fileInput"
        type="file"
        accept="application/pdf,image/jpeg,image/png,image/webp,image/gif"
        @change="onPickChange"
        hidden
      />

      <div v-if="uploading" class="state">
        <p class="primary">Parsing receipt…</p>
        <p class="hint">~5 seconds for the vision call</p>
      </div>

      <div v-else-if="!file" class="state">
        <p class="primary">Drop a receipt here or click to pick</p>
        <p class="hint">PDF or image (JPEG, PNG, WEBP, GIF) up to 5 MB</p>
      </div>

      <div v-else class="state selected">
        <p class="filename">{{ file.name }}</p>
        <p class="meta">{{ file.type }} · {{ formatSize(file.size) }}</p>
        <div class="actions" @click.stop>
          <input
            v-model="description"
            placeholder="optional context (e.g. 'lunch with X')"
          />
          <button @click="clearFile">Remove</button>
          <button @click="upload" class="primary">Upload &amp; parse</button>
        </div>
      </div>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <p v-if="lastResult" class="success">
      Uploaded — parser returned
      <strong>{{ lastResult.status }}</strong
      ><span v-if="lastResult.reason"> ({{ lastResult.reason }})</span
      ><span v-if="lastResult.proposal?.vendor?.name">
        · {{ lastResult.proposal.vendor.name }}</span
      ><span v-if="lastResult.proposal?.total">
        · {{ lastResult.proposal.total.amount }}
        {{ lastResult.proposal.total.currency }}</span
      >
    </p>
  </div>
</template>

<style scoped>
.upload-card {
  margin-bottom: 1.5rem;
}

.drop-zone {
  border: 2px dashed var(--border);
  border-radius: var(--radius);
  padding: 1.25rem;
  background: var(--surface);
  text-align: center;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}

.drop-zone:hover:not(.has-file):not(.busy) {
  border-color: var(--accent);
}

.drop-zone.active {
  border-color: var(--accent);
  background: #eff6ff;
}

.drop-zone.has-file {
  cursor: default;
  text-align: left;
  border-style: solid;
}

.drop-zone.busy {
  cursor: progress;
  opacity: 0.75;
}

.state .primary {
  margin: 0;
  font-weight: 500;
}

.state .hint {
  margin: 0.25rem 0 0;
  color: var(--text-muted);
  font-size: 13px;
}

.selected .filename {
  margin: 0;
  font-weight: 600;
}

.selected .meta {
  margin: 0.25rem 0 0.75rem;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 12px;
}

.actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.actions input {
  flex: 1;
}

.error {
  background: #fef2f2;
  color: var(--danger);
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius);
  border: 1px solid #fca5a5;
  margin: 0.75rem 0 0;
  font-size: 13px;
}

.success {
  background: #f0fdf4;
  color: var(--ok);
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius);
  border: 1px solid #86efac;
  margin: 0.75rem 0 0;
  font-size: 13px;
}
</style>
