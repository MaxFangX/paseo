import { expect, test } from "vitest";

import { formatFinishNotificationBody } from "./notification.js";

// PATCH(stop-notification)
test("a canceled child is reported as paused, with its partial response", () => {
  const body = formatFinishNotificationBody({
    childAgentId: "child-agent",
    title: "Child Agent",
    reason: "was canceled",
    lastAssistantMessage: "Halfway through the migration.",
  });

  expect(body).toContain("Agent child-agent (Child Agent) was canceled.");
  expect(body).toContain("Treat its work as paused, not done");
  expect(body).toContain("Halfway through the migration.");
});

test("a finished child carries no pause note", () => {
  const body = formatFinishNotificationBody({
    childAgentId: "child-agent",
    title: "Child Agent",
    reason: "finished",
    lastAssistantMessage: "Done.",
  });

  expect(body).not.toContain("paused");
});
