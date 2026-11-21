import { memo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useCacheState } from "@/hooks/use-cache-state";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { cacheStateInput, formatCacheStateLabel, isLargeContext } from "@/utils/cache-state";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

// PATCH(cache-state): the context size and prompt cache state of a Claude agent, e.g. "412k · 38m"
// while warm and "412k · cold" once the cache has expired. See utils/cache-state.ts.

function CacheStateLabel({ agent, testID }: { agent: Agent; testID: string }) {
  const input = cacheStateInput(agent);
  const state = useCacheState(input);
  if (!state) return null;
  const costly = state.kind === "cold" && isLargeContext(input.usedTokens);
  return (
    <Text style={[styles.label, costly && styles.costly]} numberOfLines={1} testID={testID}>
      {formatCacheStateLabel(state, input.usedTokens)}
    </Text>
  );
}

export const AgentCacheStateBadge = memo(function AgentCacheStateBadge({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}) {
  const agent = useSessionStore((state) => state.sessions[serverId]?.agents.get(agentId));
  return agent ? <CacheStateLabel agent={agent} testID="agent-cache-state" /> : null;
});

/**
 * A workspace row stands for several agents; it shows the one with the most context, since that
 * is the one that costs the most to wake.
 */
const WorkspaceCacheStateBadge = memo(function WorkspaceCacheStateBadge({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const agent = useSessionStore((state) =>
    selectLargestClaudeAgent(state.sessions[serverId]?.agents, workspaceId),
  );
  return agent ? <CacheStateLabel agent={agent} testID="workspace-cache-state" /> : null;
});

/**
 * A workspace row's name, then its {@link WorkspaceCacheStateBadge} where the name leaves room. A
 * badge that does not fit wraps onto a second line, which is clipped, so it never cuts the name.
 */
export function WorkspaceTitleWithCacheState({
  serverId,
  workspaceId,
  children,
}: {
  serverId: string;
  workspaceId: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.workspaceTitle}>
      <View style={styles.workspaceName}>{children}</View>
      <WorkspaceCacheStateBadge serverId={serverId} workspaceId={workspaceId} />
    </View>
  );
}

function selectLargestClaudeAgent(
  agents: ReadonlyMap<string, Agent> | undefined,
  workspaceId: string,
): Agent | null {
  let largest: Agent | null = null;
  for (const agent of agents?.values() ?? []) {
    if (agent.provider !== "claude" || agent.archivedAt || !agent.lastTurnEndedAt) continue;
    if (normalizeWorkspaceOpaqueId(agent.workspaceId) !== workspaceId) continue;
    if (!largest || usedTokens(agent) > usedTokens(largest)) largest = agent;
  }
  return largest;
}

function usedTokens(agent: Agent): number {
  return agent.lastUsage?.contextWindowUsedTokens ?? 0;
}

// The sidebar row title's line height, TITLE_LINE_HEIGHT in sidebar-workspace-row-content.tsx.
const LINE_HEIGHT = 20;

const styles = StyleSheet.create((theme) => ({
  workspaceTitle: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: theme.spacing[2],
    height: LINE_HEIGHT,
    overflow: "hidden",
  },
  // The name's own style is `flex: 1`, with no width of its own; this box gives it the width of its
  // text, so a long name takes the line before the badge does.
  workspaceName: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  label: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: LINE_HEIGHT,
    fontVariant: ["tabular-nums"],
  },
  costly: {
    color: theme.colors.statusWarning,
  },
}));
