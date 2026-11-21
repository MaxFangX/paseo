import type { IdleCompactionSettings } from "../shared/settings.js";

/** The part of an agent handle that idle compaction reads and drives. */
export interface IdleAgent {
  readonly status: string | null;
  readonly archivedAt: string | null;
  readonly pendingPermissions: readonly unknown[] | null;
  readonly lastUsage: { contextWindowUsedTokens?: number } | null;
  refresh(): Promise<unknown>;
  send(text: string, options: { activeTurnBehavior: "steer" }): Promise<unknown>;
}

interface Dependencies {
  settings(): IdleCompactionSettings;
  agent(agentId: string): IdleAgent;
  log(message: string): void;
}

/**
 * Compacts a large Claude agent shortly before its prompt cache expires. The next request to an
 * agent whose cache has expired re-writes its whole context at the cache-write price; a compaction
 * while the cache is warm reads it at the cache-read price, and leaves a small context to re-write.
 */
export function createIdleCompaction(deps: Dependencies) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Agents whose running turn is a compaction sent from here.
  const compacting = new Set<string>();

  function cancel(agentId: string): void {
    clearTimeout(timers.get(agentId));
    timers.delete(agentId);
  }

  async function compactIfIdle(agentId: string): Promise<void> {
    const settings = deps.settings();
    if (!settings.enabled) return;
    const agent = deps.agent(agentId);
    await agent.refresh();
    if (agent.status !== "idle" || agent.archivedAt || agent.pendingPermissions?.length) return;
    const used = agent.lastUsage?.contextWindowUsedTokens ?? 0;
    if (used <= settings.thresholdTokens) return;

    deps.log(`Compacting idle agent ${agentId} at ${used} tokens`);
    compacting.add(agentId);
    try {
      // Should a turn have started since the refresh, steering leaves it running.
      await agent.send("/compact", { activeTurnBehavior: "steer" });
    } catch (error) {
      compacting.delete(agentId);
      throw error;
    }
  }

  return {
    turnStarted: cancel,
    turnEnded(agentId: string): void {
      cancel(agentId);
      // One compaction per idle period: its own turn's end does not arm another.
      if (compacting.delete(agentId)) return;
      const settings = deps.settings();
      if (!settings.enabled) return;
      const timer = setTimeout(() => {
        timers.delete(agentId);
        compactIfIdle(agentId).catch((error) =>
          deps.log(`Idle compaction of agent ${agentId} failed: ${String(error)}`),
        );
      }, settings.idleMinutes * 60_000);
      timers.set(agentId, timer);
    },
    forget(agentId: string): void {
      cancel(agentId);
      compacting.delete(agentId);
    },
    close(): void {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      compacting.clear();
    },
  };
}
