// PATCH(agent-move): fork-only module.
import { describe, expect, it } from "vitest";
import { selectMoveAgentDestinations } from "@/screens/workspace/move-agent-menu";
import type { WorkspaceDescriptor } from "@/stores/session-store";

function workspace(input: {
  id: string;
  projectId: string;
  name: string;
  title?: string | null;
  archivingAt?: string | null;
}): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: input.projectId,
    projectDisplayName: input.projectId,
    projectRootPath: `/repo/${input.projectId}`,
    workspaceDirectory: `/repo/${input.projectId}/${input.name}`,
    projectKind: "git",
    workspaceKind: "worktree",
    name: input.name,
    title: input.title ?? null,
    status: "idle",
    statusEnteredAt: null,
    archivingAt: input.archivingAt ?? null,
    diffStat: null,
    scripts: [],
  } as unknown as WorkspaceDescriptor;
}

describe("selectMoveAgentDestinations", () => {
  it("lists the project's other live workspaces first, then other projects' by project", () => {
    const workspaces = new Map(
      [
        workspace({ id: "ws-current", projectId: "p1", name: "10-05-app-dark-mode" }),
        workspace({ id: "ws-b", projectId: "p1", name: "10-06-app-general" }),
        workspace({ id: "ws-a", projectId: "p1", name: "zzz", title: "01-backend" }),
        workspace({ id: "ws-archiving", projectId: "p1", name: "gone", archivingAt: "now" }),
        workspace({ id: "ws-z2", projectId: "z-project", name: "main" }),
        workspace({ id: "ws-m1", projectId: "m-project", name: "main" }),
      ].map((entry) => [entry.id, entry] as const),
    );

    expect(selectMoveAgentDestinations(workspaces, "ws-current").map((entry) => entry.id)).toEqual([
      "ws-a",
      "ws-b",
      "ws-m1",
      "ws-z2",
    ]);
  });

  it("lists nothing when the current workspace is unknown", () => {
    const workspaces = new Map([["ws-b", workspace({ id: "ws-b", projectId: "p1", name: "b" })]]);

    expect(selectMoveAgentDestinations(workspaces, "ws-missing")).toEqual([]);
    expect(selectMoveAgentDestinations(undefined, "ws-b")).toEqual([]);
  });
});
