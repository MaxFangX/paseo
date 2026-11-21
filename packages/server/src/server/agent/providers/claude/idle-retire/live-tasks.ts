/**
 * PATCH(idle-retire): every task the Claude process has started and not yet ended.
 *
 * The subagent source only lists the tasks it declares (`local_agent`, `local_workflow`). Verified
 * on the wire (Claude Code 2.1.321): a background Bash command and a Monitor both start as
 * `task_type: "local_bash"`, and both end with `task_updated` (`patch.status: "completed"`) and a
 * `task_notification`. They live inside the process, so they keep it alive as well.
 */

/** `task_updated` statuses after which a task no longer runs; every `task_notification` is final. */
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "killed", "stopped"]);

export class LiveTasks {
  private readonly running = new Set<string>();

  get count(): number {
    return this.running.size;
  }

  observe(message: unknown): void {
    const record = asRecord(message);
    if (record?.type !== "system" || typeof record.task_id !== "string") return;
    switch (record.subtype) {
      case "task_started":
        this.running.add(record.task_id);
        break;
      case "task_notification":
        this.running.delete(record.task_id);
        break;
      case "task_updated": {
        const status = asRecord(record.patch)?.status;
        if (typeof status === "string" && TERMINAL_TASK_STATUSES.has(status)) {
          this.running.delete(record.task_id);
        }
        break;
      }
      default:
        break;
    }
  }

  /** Tasks die with their process. */
  processEnded(): void {
    this.running.clear();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
