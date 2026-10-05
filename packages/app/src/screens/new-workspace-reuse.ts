// PATCH(workspace-reuse): fork-only module.
//
// Picking a git project's own checkout on the New Workspace screen means "work in that
// checkout", and when it is already open, that is its existing workspace. Upstream lets a
// directory hold several workspaces so that non-git projects can add one at all; for a
// project that can cut worktrees, a second workspace on the checkout is only a duplicate.
import { useStoreWithEqualityFn } from "zustand/traditional";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type {
  CreateWorkspaceRequestOptions,
  DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
import { getHostProjectId, type HostProjectListItem } from "@/projects/host-project-model";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { normalizeWorkspacePath } from "@/utils/workspace-identity";

/** The open workspace of `projectId` whose directory is `directory`, if any. */
export function findOpenWorkspaceForCheckout(input: {
  workspaces: Iterable<WorkspaceDescriptor> | undefined;
  projectId: string | null;
  directory: string | null;
}): WorkspaceDescriptor | null {
  const directory = normalizeWorkspacePath(input.directory);
  if (!input.workspaces || !input.projectId || !directory) {
    return null;
  }
  for (const workspace of input.workspaces) {
    if (workspace.projectId === input.projectId && workspace.workspaceDirectory === directory) {
      return workspace;
    }
  }
  return null;
}

/** The open workspace a local-isolation submission lands in, for a project that can cut worktrees. */
export function useOpenWorkspaceForCheckout(input: {
  serverId: string;
  project: HostProjectListItem | null;
  directory: string | null;
  isolation: "local" | "worktree";
  canCreateWorktree: boolean;
}): WorkspaceDescriptor | null {
  const projectId = input.project ? getHostProjectId(input.project, input.serverId) : null;
  const enabled = input.canCreateWorktree && input.isolation === "local";
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) =>
      enabled
        ? findOpenWorkspaceForCheckout({
            workspaces: state.sessions[input.serverId]?.workspaces?.values(),
            projectId,
            directory: input.directory,
          })
        : null,
    (left, right) => left?.id === right?.id,
  );
}

/** `ensure`, unless the checkout's workspace is already open, which then stands in for it. */
export function preferOpenWorkspace<T>(
  open: WorkspaceDescriptor | null,
  ensure: (input: T) => Promise<WorkspaceDescriptor>,
): (input: T) => Promise<WorkspaceDescriptor> {
  return async (input) => open ?? ensure(input);
}

/**
 * Creates the draft's agent in an already-open workspace. Opening the draft there first
 * mirrors a creation's workspace_ready event, so the pending state shows at once.
 */
export async function createAgentInOpenWorkspace(input: {
  client: DaemonClient;
  workspace: WorkspaceDescriptor;
  agent: NonNullable<CreateWorkspaceRequestOptions["agent"]>;
  idempotencyKey: string;
  openDraft: (workspace: WorkspaceDescriptor) => void;
}): Promise<{ workspace: WorkspaceDescriptor; agent: AgentSnapshotPayload }> {
  input.openDraft(input.workspace);
  const agent = await input.client.createAgent({
    ...input.agent,
    workspaceId: input.workspace.id,
    idempotencyKey: input.idempotencyKey,
  });
  return { workspace: input.workspace, agent };
}
