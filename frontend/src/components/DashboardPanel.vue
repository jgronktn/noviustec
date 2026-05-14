<script setup>
import { ref, watch } from "vue";
import ReviewPanel from "./ReviewPanel.vue";

const props = defineProps({
  token: { type: String, required: true },
  selectedId: { type: String, default: null },
});
const emit = defineEmits(["close"]);

// Force-remount ReviewPanel when selectedId changes so its onMounted
// fetches the new pending entry's data instead of holding stale state.
const reviewKey = ref(0);
watch(
  () => props.selectedId,
  () => {
    reviewKey.value += 1;
  },
);
</script>

<template>
  <ReviewPanel
    v-if="selectedId"
    :key="reviewKey"
    :token="token"
    :id="selectedId"
    @back="emit('close')"
  />
  <div v-else class="empty">
    <div class="empty-card">
      <p class="title">Pick a receipt from the inbox to review</p>
      <p class="hint">
        Or drop a PDF/image into the upload zone on the left.
        Future agent-rendered panels (P&amp;L, vendor history, etc.) will
        appear here.
      </p>
    </div>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 2rem;
}

.empty-card {
  text-align: center;
  max-width: 480px;
  color: var(--text-muted);
}

.empty-card .title {
  font-size: 1.05rem;
  font-weight: 500;
  color: var(--text);
  margin: 0 0 0.5rem;
}

.empty-card .hint {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.5;
}
</style>
