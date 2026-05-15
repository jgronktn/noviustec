<script setup>
import { ref, provide } from "vue";
import TokenGate from "./components/TokenGate.vue";
import InboxPanel from "./components/InboxPanel.vue";
import PromptPanel from "./components/PromptPanel.vue";
import DashboardPanel from "./components/DashboardPanel.vue";

// Injected by vite.config.js at build time. Hover the badge to see when
// the bundle was built; the value is the short git SHA (with a "+" suffix
// if the working tree was dirty at build time).
const BUILD_SHA = __BUILD_SHA__;
const BUILD_TIME = __BUILD_TIME__;

const STORAGE_KEY = "noviustec_token";

const token = ref(localStorage.getItem(STORAGE_KEY) || "");
const selectedPendingId = ref(null);
const inboxKey = ref(0); // bump to force InboxPanel reload after approve/reject

// Expose the token to deeply-nested canvas panels (e.g. FileListPanel
// download buttons) without prop-drilling. Provide the ref itself so
// updates propagate after sign-in / sign-out.
provide("apiToken", token);

// Agent-pushed canvas panels. Newest on top. Persists across review-panel
// toggles — agent panels stay parked while the user reviews a pending row.
const agentPanels = ref([]); // [{id, kind, title, props}]

function onTokenSet(t) {
  token.value = t;
  localStorage.setItem(STORAGE_KEY, t);
}

function logout() {
  token.value = "";
  localStorage.removeItem(STORAGE_KEY);
  selectedPendingId.value = null;
  agentPanels.value = [];
}

function openPending(id) {
  selectedPendingId.value = id;
}

function closeReview() {
  selectedPendingId.value = null;
  inboxKey.value += 1;
}

// Panel kinds that take over the whole canvas — pushing one of these
// clears the existing stack so the canvas isn't split. Vendor timelines
// are dense vertical layouts that don't share well; other panels are
// designed to coexist.
const EXCLUSIVE_KINDS = new Set(["vendor_timeline"]);

function onAgentPanel(panel) {
  if (EXCLUSIVE_KINDS.has(panel.kind)) {
    agentPanels.value = [panel];
    return;
  }
  // Otherwise push to front — newest panels appear on top of the stack.
  agentPanels.value = [panel, ...agentPanels.value];
}

function dismissPanel(id) {
  agentPanels.value = agentPanels.value.filter((p) => p.id !== id);
}

function clearPanels() {
  agentPanels.value = [];
}
</script>

<template>
  <TokenGate v-if="!token" @token-set="onTokenSet" />

  <div v-else class="app-grid">
    <aside class="sidebar">
      <div class="pane inbox-pane">
        <InboxPanel
          :key="inboxKey"
          :token="token"
          :selected-id="selectedPendingId"
          @open="openPending"
        />
      </div>
      <div class="pane prompt-pane">
        <PromptPanel :token="token" @panel="onAgentPanel" />
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div class="brand">
          <span class="logo">◐</span>
          <span class="name">Noviustec</span>
          <span class="env" :title="`Built ${BUILD_TIME}`">{{ BUILD_SHA }}</span>
        </div>
        <div class="actions">
          <button @click="logout" class="ghost">Sign out</button>
        </div>
      </header>
      <section class="dashboard">
        <DashboardPanel
          :token="token"
          :selected-id="selectedPendingId"
          :panels="agentPanels"
          @close="closeReview"
          @dismiss-panel="dismissPanel"
          @clear-panels="clearPanels"
        />
      </section>
    </main>
  </div>
</template>

<style scoped>
.app-grid {
  display: grid;
  grid-template-columns: 320px 1fr;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
}

@media (max-width: 800px) {
  .app-grid {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
    height: 100vh;
  }
}

.sidebar {
  display: grid;
  grid-template-rows: 1fr 1fr;
  border-right: 1px solid var(--border);
  background: var(--surface);
  min-height: 0;
}

.pane {
  min-height: 0;
  overflow: hidden;
}

.inbox-pane {
  /* Inner InboxPanel owns its own scroll region (only the list scrolls;
     header + upload zone stay pinned). The pane itself just clips. */
  border-bottom: 1px solid var(--border);
}

.prompt-pane {
  display: flex;
  flex-direction: column;
}

.main {
  display: grid;
  grid-template-rows: 80px 1fr;
  min-height: 0;
  overflow: hidden;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 1.5rem;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  height: 80px;
  box-sizing: border-box;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.logo {
  font-size: 1.75rem;
  color: var(--accent);
}

.name {
  font-weight: 600;
  font-size: 1.1rem;
}

.env {
  font-size: 0.75rem;
  color: var(--text-muted);
  background: #f0f0eb;
  padding: 2px 6px;
  border-radius: 4px;
  font-family: var(--font-mono);
}

.actions button.ghost {
  background: transparent;
  border-color: transparent;
  color: var(--text-muted);
}

.actions button.ghost:hover {
  background: #f5f5f0;
  color: var(--text);
}

.dashboard {
  overflow-y: auto;
  padding: 1.5rem;
  background: var(--bg);
  min-height: 0;
}
</style>
