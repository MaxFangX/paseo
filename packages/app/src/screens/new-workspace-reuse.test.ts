// PATCH(workspace-reuse): fork-only module.
import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { findOpenWorkspaceForCheckout } from "./new-workspace-reuse";

function workspace(id: string, projectId: string, workspaceDirectory: string): WorkspaceDescriptor {
  return { id, projectId, workspaceDirectory } as WorkspaceDescriptor;
}

const main = workspace("wks_main", "proj-paseo", "/Users/me/dev/paseo");
const worktree = workspace("wks_wt", "proj-paseo", "/Users/me/dev/paseo/.worktrees/a");
const other = workspace("wks_other", "proj-other", "/Users/me/dev/paseo");

describe("findOpenWorkspaceForCheckout", () => {
  it("finds the project's workspace at the directory, ignoring a trailing slash", () => {
    expect(
      findOpenWorkspaceForCheckout({
        workspaces: [worktree, other, main],
        projectId: "proj-paseo",
        directory: "/Users/me/dev/paseo/",
      }),
    ).toBe(main);
  });

  it("does not match another project's workspace at the same directory", () => {
    expect(
      findOpenWorkspaceForCheckout({
        workspaces: [other],
        projectId: "proj-paseo",
        directory: "/Users/me/dev/paseo",
      }),
    ).toBeNull();
  });

  it("is null without workspaces, a project, or a directory", () => {
    expect(
      findOpenWorkspaceForCheckout({ workspaces: undefined, projectId: "p", directory: "/d" }),
    ).toBeNull();
    expect(
      findOpenWorkspaceForCheckout({ workspaces: [main], projectId: null, directory: "/d" }),
    ).toBeNull();
    expect(
      findOpenWorkspaceForCheckout({ workspaces: [main], projectId: "proj-paseo", directory: "" }),
    ).toBeNull();
  });
});
