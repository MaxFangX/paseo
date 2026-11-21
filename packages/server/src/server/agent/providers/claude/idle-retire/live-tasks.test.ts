import { describe, expect, it } from "vitest";
import { LiveTasks } from "./live-tasks.js";

function started(taskId: string, taskType: string) {
  return {
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    task_type: taskType,
    is_backgrounded: true,
  };
}

describe("LiveTasks", () => {
  it("counts a background Bash job and a Monitor until each ends", () => {
    const tasks = new LiveTasks();
    // Both announce as local_bash, which the subagent source does not list.
    tasks.observe(started("bash1", "local_bash"));
    tasks.observe(started("monitor1", "local_bash"));
    expect(tasks.count).toBe(2);

    tasks.observe({
      type: "system",
      subtype: "task_updated",
      task_id: "monitor1",
      patch: { status: "completed", end_time: 1 },
    });
    expect(tasks.count).toBe(1);

    tasks.observe({
      type: "system",
      subtype: "task_notification",
      task_id: "bash1",
      status: "completed",
    });
    expect(tasks.count).toBe(0);
  });

  it("counts subagents and workflows too", () => {
    const tasks = new LiveTasks();
    tasks.observe(started("agent1", "local_agent"));
    tasks.observe(started("wf1", "local_workflow"));

    expect(tasks.count).toBe(2);
  });

  it("ends a task on a kill or failure", () => {
    const tasks = new LiveTasks();
    tasks.observe(started("a", "local_bash"));
    tasks.observe(started("b", "local_bash"));
    tasks.observe({
      type: "system",
      subtype: "task_updated",
      task_id: "a",
      patch: { status: "killed" },
    });
    tasks.observe({ type: "system", subtype: "task_notification", task_id: "b", status: "failed" });

    expect(tasks.count).toBe(0);
  });

  it("keeps a task through non-terminal updates", () => {
    const tasks = new LiveTasks();
    tasks.observe(started("a", "local_agent"));
    tasks.observe({
      type: "system",
      subtype: "task_updated",
      task_id: "a",
      patch: { status: "paused", is_backgrounded: true },
    });
    tasks.observe({ type: "system", subtype: "task_progress", task_id: "a" });

    expect(tasks.count).toBe(1);
  });

  it("forgets every task when the process ends", () => {
    const tasks = new LiveTasks();
    tasks.observe(started("a", "local_bash"));
    tasks.processEnded();

    expect(tasks.count).toBe(0);
  });
});
