<script setup>
import { ref } from "vue";
import TokenGate from "./components/TokenGate.vue";
import InboxPanel from "./components/InboxPanel.vue";
import ReviewPanel from "./components/ReviewPanel.vue";

// Injected by vite.config.js at build time. Hover the badge to see when
// the bundle was built; the value is the short git SHA (with a "+" suffix
// if the working tree was dirty at build time).
const BUILD_SHA = __BUILD_SHA__;
const BUILD_TIME = __BUILD_TIME__;

const STORAGE_KEY = "noviustec_token";

const token = ref(localStorage.getItem(STORAGE_KEY) || "");
const view = ref("inbox"); // "inbox" | "review"
const selectedId = ref(null);
const inboxKey = ref(0); // bump to force InboxPanel reload after approve/reject

function onTokenSet(t) {
  token.value = t;
  localStorage.setItem(STORAGE_KEY, t);
}

function logout() {
  token.value = "";
  localStorage.removeItem(STORAGE_KEY);
  view.value = "inbox";
  selectedId.value = null;
}

function openReview(id) {
  selectedId.value = id;
  view.value = "review";
}

function backToInbox() {
  selectedId.value = null;
  view.value = "inbox";
  inboxKey.value += 1; // re-mount InboxPanel so it refetches
}
</script>

<template>
  <div class="app">
    <header>
      <div class="brand">
        <span class="logo">◐</span>
        <span class="name">Noviustec</span>
        <span class="env" :title="`Built ${BUILD_TIME}`">{{ BUILD_SHA }}</span>
      </div>
      <div class="actions">
        <button v-if="token" @click="logout" class="ghost">Sign out</button>
      </div>
    </header>

    <main>
      <TokenGate v-if="!token" @token-set="onTokenSet" />
      <InboxPanel
        v-else-if="view === 'inbox'"
        :key="inboxKey"
        :token="token"
        @open="openReview"
      />
      <ReviewPanel
        v-else-if="view === 'review'"
        :token="token"
        :id="selectedId"
        @back="backToInbox"
      />
    </main>
  </div>
</template>

<style scoped>
.app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1.5rem;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 10;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.logo {
  font-size: 1.5rem;
  color: var(--accent);
}

.name {
  font-weight: 600;
  font-size: 1rem;
}

.env {
  font-size: 0.75rem;
  color: var(--text-muted);
  background: #f0f0eb;
  padding: 2px 6px;
  border-radius: 4px;
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

main {
  flex: 1;
  padding: 2rem 1.5rem;
  max-width: 1100px;
  margin: 0 auto;
  width: 100%;
}
</style>
