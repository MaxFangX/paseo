// PATCH(agent-mark-unread): fork-only module.
//
// The "Mark as unread" row on an agent tab's menu. Both tab menus (the desktop context menu
// and the mobile sheet) render it from the same entry.
import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Circle } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { MenuItem } from "@/components/ui/menu";
import { useToast } from "@/contexts/toast-context";
import { canMarkAgentUnread, markAgentUnread } from "@/hooks/mark-agent-unread";
import { useHostFeature } from "@/runtime/host-features";
import type { WorkspaceTabMenuEntry } from "@/screens/workspace/workspace-tab-menu";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";

export type MarkAgentUnreadMenuEntry = Extract<WorkspaceTabMenuEntry, { kind: "mark-unread" }>;

const ThemedCircle = withUnistyles(Circle);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function MarkAgentUnreadMenuItem({
  entry,
}: {
  entry: MarkAgentUnreadMenuEntry;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const { serverId, canMark } = useSessionStore(
    useShallow((state) => {
      for (const [hostId, session] of Object.entries(state.sessions)) {
        const agent = session?.agents.get(entry.agentId);
        if (agent) return { serverId: hostId, canMark: canMarkAgentUnread(agent) };
      }
      return { serverId: null, canMark: false };
    }),
  );
  const supported = useHostFeature(serverId, "agentMarkUnread");
  const leading = useMemo(() => <ThemedCircle size={16} uniProps={mutedColorMapping} />, []);
  const select = useCallback(() => {
    if (!serverId) return;
    markAgentUnread({ serverId, agentId: entry.agentId, tabId: entry.tabId }).catch(
      (error: unknown) => {
        toast.error(
          error instanceof Error ? error.message : t("workspace.tabs.menu.markAgentUnreadFailed"),
        );
      },
    );
  }, [entry.agentId, entry.tabId, serverId, t, toast]);
  return (
    <MenuItem
      leading={leading}
      disabled={!supported || !canMark}
      onSelect={select}
      testID={entry.testID}
    >
      {t("workspace.tabs.menu.markAgentUnread")}
    </MenuItem>
  );
}
