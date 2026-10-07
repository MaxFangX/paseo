// PATCH(agent-move): fork-only module.
//
// The "Move to workspace" row on an agent tab's menu and the page behind it, which lists the
// host's other workspaces, the agent's own project first. Both tab menus (the desktop context menu and the
// mobile sheet) render the row from the same entry and pass the same page to their surface.
import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { FolderInput } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { useToast } from "@/contexts/toast-context";
import {
  MenuHint,
  MenuItem,
  MenuSeparator,
  MenuSubTrigger,
  type MenuPageDefinition,
} from "@/components/ui/menu";
import { moveAgentToWorkspace } from "@/hooks/move-agent";
import { useHostFeature } from "@/runtime/host-features";
import type { WorkspaceTabMenuEntry } from "@/screens/workspace/workspace-tab-menu";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

export const MOVE_AGENT_PAGE_ID = "moveAgent";

export type MoveAgentMenuEntry = Extract<WorkspaceTabMenuEntry, { kind: "move-agent" }>;

const ThemedFolderInput = withUnistyles(FolderInput);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const NO_PAGES: readonly MenuPageDefinition[] = [];

interface AgentHome {
  serverId: string;
  workspaceId: string | null;
}

/** Which host holds the agent, and which workspace it is in now. */
function useAgentHome(agentId: string | null): AgentHome | null {
  return useSessionStore(
    useShallow((state): AgentHome | null => {
      if (!agentId) return null;
      for (const [serverId, session] of Object.entries(state.sessions)) {
        const agent = session?.agents.get(agentId);
        if (agent) {
          return { serverId, workspaceId: normalizeWorkspaceOpaqueId(agent.workspaceId) };
        }
      }
      return null;
    }),
  );
}

export function MoveAgentSubTrigger({ entry }: { entry: MoveAgentMenuEntry }): ReactElement {
  const { t } = useTranslation();
  const home = useAgentHome(entry.agentId);
  const supported = useHostFeature(home?.serverId, "agentMove");
  const leading = useMemo(() => <ThemedFolderInput size={16} uniProps={mutedColorMapping} />, []);
  return (
    <MenuSubTrigger
      id={MOVE_AGENT_PAGE_ID}
      leading={leading}
      disabled={!supported || !home?.workspaceId}
      testID={entry.testID}
    >
      {t("workspace.tabs.menu.moveAgent")}
    </MenuSubTrigger>
  );
}

/** The page behind the entry's row, when the menu has one. */
export function useMoveAgentMenuPages(
  entries: readonly WorkspaceTabMenuEntry[],
): readonly MenuPageDefinition[] {
  const { t } = useTranslation();
  const entry = entries.find((candidate) => candidate.kind === "move-agent") ?? null;
  const home = useAgentHome(entry?.agentId ?? null);
  return useMemo(() => {
    if (!entry || !home?.workspaceId) return NO_PAGES;
    return [
      {
        id: MOVE_AGENT_PAGE_ID,
        title: t("workspace.tabs.menu.moveAgent"),
        content: (
          <MoveAgentPage
            serverId={home.serverId}
            workspaceId={home.workspaceId}
            agentId={entry.agentId}
            tabId={entry.tabId}
          />
        ),
      },
    ];
  }, [entry, home?.serverId, home?.workspaceId, t]);
}

/** Every other live workspace on the host: the agent's project first, then the rest by project. */
export function selectMoveAgentDestinations(
  workspaces: ReadonlyMap<string, WorkspaceDescriptor> | undefined,
  workspaceId: string,
): WorkspaceDescriptor[] {
  const current = workspaces?.get(workspaceId);
  if (!workspaces || !current) return [];
  const rank = (workspace: WorkspaceDescriptor) =>
    workspace.projectId === current.projectId ? "" : workspace.projectDisplayName;
  return Array.from(workspaces.values())
    .filter((workspace) => workspace.id !== workspaceId && !workspace.archivingAt)
    .sort(
      (left, right) =>
        rank(left).localeCompare(rank(right)) ||
        workspaceLabel(left).localeCompare(workspaceLabel(right)),
    );
}

function workspaceLabel(workspace: WorkspaceDescriptor): string {
  return workspace.title ?? workspace.name;
}

function MoveAgentPage({
  serverId,
  workspaceId,
  agentId,
  tabId,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  tabId: string;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const projectId = useSessionStore(
    (state) => state.sessions[serverId]?.workspaces.get(workspaceId)?.projectId,
  );
  const destinations = useSessionStore(
    useShallow((state) =>
      selectMoveAgentDestinations(state.sessions[serverId]?.workspaces, workspaceId),
    ),
  );
  const move = useCallback(
    (destination: WorkspaceDescriptor) => {
      moveAgentToWorkspace({ serverId, agentId, tabId, workspaceId: destination.id }).catch(
        (error: unknown) => {
          toast.error(
            error instanceof Error ? error.message : t("workspace.tabs.menu.moveAgentFailed"),
          );
        },
      );
    },
    [agentId, serverId, t, tabId, toast],
  );
  if (destinations.length === 0) {
    return (
      <MenuHint testID="move-agent-page-empty">{t("workspace.tabs.menu.moveAgentEmpty")}</MenuHint>
    );
  }
  const sameProject = destinations.filter((destination) => destination.projectId === projectId);
  const elsewhere = destinations.slice(sameProject.length);
  return (
    <>
      {sameProject.map((destination) => (
        <MoveAgentRow key={destination.id} destination={destination} onMove={move} />
      ))}
      {sameProject.length > 0 && elsewhere.length > 0 ? <MenuSeparator /> : null}
      {elsewhere.map((destination) => (
        <MoveAgentRow key={destination.id} destination={destination} onMove={move} showProject />
      ))}
    </>
  );
}

function MoveAgentRow({
  destination,
  onMove,
  showProject = false,
}: {
  destination: WorkspaceDescriptor;
  onMove: (destination: WorkspaceDescriptor) => void;
  /** Names the project too, for a workspace outside the agent's own. */
  showProject?: boolean;
}): ReactElement {
  const select = useCallback(() => onMove(destination), [destination, onMove]);
  return (
    <MenuItem
      onSelect={select}
      description={showProject ? destination.projectDisplayName : undefined}
      testID={`move-agent-page-row-${destination.id}`}
    >
      {workspaceLabel(destination)}
    </MenuItem>
  );
}
