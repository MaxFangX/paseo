// PATCH(native-fork): fork-only module.
import { describe, expect, it } from "vitest";
import type { ChatHistoryContextAttachment, ComposerAttachment } from "@/attachments/types";
import { resolveAgentForkSource } from "./new-workspace-native-fork";

function chatHistory(source: ChatHistoryContextAttachment["source"]): ChatHistoryContextAttachment {
  return {
    kind: "chat_history",
    id: "chat_history:draft-1",
    attachment: { type: "text", mimeType: "text/plain", title: "Chat history", text: "..." },
    source,
  };
}

const file: ComposerAttachment = {
  kind: "workspace_file",
  path: "/repo/notes.md",
  selection: { kind: "whole_file" },
};

describe("resolveAgentForkSource", () => {
  it("names the attachment's source turn on the same host", () => {
    expect(
      resolveAgentForkSource({
        serverId: "host-1",
        attachments: [
          file,
          chatHistory({
            serverId: "host-1",
            agentId: "agent-1",
            boundaryMessageId: "msg-9",
            boundaryCursor: { epoch: "e1", seq: 4 },
          }),
        ],
      }),
    ).toEqual({ agentId: "agent-1", boundaryMessageId: "msg-9" });
  });

  it("leaves a turn without a message id, or on another host, to the attachment", () => {
    expect(
      resolveAgentForkSource({
        serverId: "host-1",
        attachments: [
          chatHistory({
            serverId: "host-1",
            agentId: "agent-1",
            boundaryCursor: { epoch: "e1", seq: 4 },
          }),
        ],
      }),
    ).toBeUndefined();
    expect(
      resolveAgentForkSource({
        serverId: "host-2",
        attachments: [
          chatHistory({ serverId: "host-1", agentId: "agent-1", boundaryMessageId: "m" }),
        ],
      }),
    ).toBeUndefined();
  });

  it("is undefined without a chat-history attachment", () => {
    expect(resolveAgentForkSource({ serverId: "host-1", attachments: [file] })).toBeUndefined();
  });
});
