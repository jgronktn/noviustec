<script setup>
import { ref } from "vue";

const props = defineProps({ token: { type: String, required: true } });

const prompt = ref("");
const history = ref([]); // [{ text, kind: "user"|"agent", time }]

// Phase 2 placeholder. When the agent loop ships, this will POST to
// /api/agent/chat (or stream events) and feed responses back into
// `history` while emitting canvas/dashboard reshape signals to App.vue.
function submit() {
  const text = prompt.value.trim();
  if (!text) return;
  history.value.push({ text, kind: "user", time: Date.now() });
  history.value.push({
    text: "Agent isn't wired up yet — this lands in Phase 2. The substrate (ledger, parser, archive, awaiting workflow) is in place; next step is the Sonnet 4.6 tool-use loop.",
    kind: "agent",
    time: Date.now() + 1,
  });
  prompt.value = "";
}

function onKeydown(e) {
  // Cmd/Ctrl+Enter submits — like most chat UIs.
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    submit();
  }
}
</script>

<template>
  <div class="prompt-panel">
    <header class="head">
      <h3>Ask</h3>
      <span class="phase-tag">Phase 2</span>
    </header>

    <div class="history" v-if="history.length > 0">
      <div
        v-for="(turn, i) in history"
        :key="i"
        class="turn"
        :class="turn.kind"
      >
        <span class="label">{{ turn.kind === "user" ? "You" : "Agent" }}</span>
        <p>{{ turn.text }}</p>
      </div>
    </div>

    <div v-else class="empty-hint">
      <p>
        Natural-language interface to your books. <strong>Coming in Phase 2.</strong>
      </p>
      <p class="examples">Example prompts:</p>
      <ul>
        <li>"Show me cloud spend by month for 2026"</li>
        <li>"What's outstanding from RNZ Electric?"</li>
        <li>"Approve the latest DigitalOcean invoice"</li>
      </ul>
    </div>

    <form class="composer" @submit.prevent="submit">
      <textarea
        v-model="prompt"
        @keydown="onKeydown"
        placeholder="Ask anything about your books…"
        rows="3"
      />
      <div class="composer-actions">
        <span class="hint">⌘/Ctrl+Enter</span>
        <button type="submit" :disabled="!prompt.trim()" class="primary">
          Send
        </button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.prompt-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 0.75rem;
  background: var(--surface);
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.head h3 {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
}

.phase-tag {
  font-size: 0.7rem;
  color: var(--text-muted);
  background: #f0f0eb;
  padding: 2px 6px;
  border-radius: 4px;
  font-family: var(--font-mono);
}

.history {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  padding-right: 0.25rem;
}

.turn {
  font-size: 0.85rem;
}

.turn .label {
  font-weight: 600;
  font-size: 0.7rem;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.turn p {
  margin: 0.2rem 0 0;
  line-height: 1.4;
}

.turn.user p {
  color: var(--text);
}

.turn.agent p {
  color: var(--text-muted);
  font-style: italic;
}

.empty-hint {
  flex: 1;
  overflow-y: auto;
  font-size: 0.8rem;
  color: var(--text-muted);
  margin-bottom: 0.5rem;
}

.empty-hint p {
  margin: 0 0 0.5rem;
}

.empty-hint .examples {
  margin-top: 0.75rem;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 600;
}

.empty-hint ul {
  margin: 0.25rem 0 0;
  padding-left: 1rem;
  list-style: disc;
}

.empty-hint li {
  margin-bottom: 0.25rem;
  line-height: 1.3;
}

.composer {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-top: auto;
}

.composer textarea {
  resize: none;
  font-size: 0.85rem;
  padding: 0.5rem 0.6rem;
}

.composer-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.composer-actions .hint {
  font-size: 0.7rem;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.composer-actions button {
  padding: 0.35rem 0.9rem;
  font-size: 0.85rem;
}
</style>
