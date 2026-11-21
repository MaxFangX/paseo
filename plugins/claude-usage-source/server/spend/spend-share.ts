import type { UsageDetail } from "@getpaseo/plugin/server";
import type { SpendPoint } from "./transcript-spend.js";

// PATCH(usage-spend-share): each Paseo agent's share of a usage window's spend, as detail rows.

/** The Paseo agent running a Claude session. */
export interface SessionOwner {
  agentId: string;
  title: string;
}

interface AgentSpend {
  title: string;
  cost: number;
}

/** One window's spend, by agent. */
export interface WindowSpend {
  total: number;
  agents: Map<string, AgentSpend>;
  /** Spent by sessions no agent runs. */
  unowned: number;
}

export interface ShareWindow {
  /** Names the window in a row's value, e.g. "session". */
  name: string;
  /** Null when the window has no known start or no spend. */
  spend: WindowSpend | null;
}

interface ShareRow {
  id: string;
  title: string;
  /** One per window with spend, in window order. */
  shares: number[];
}

/** Agents with the most spend in each window get a row. */
const TOP_PER_WINDOW = 3;

/** Spend since `start`, by agent; null when there is none. */
export function windowSpend(
  sessions: ReadonlyMap<string, readonly SpendPoint[]>,
  start: number,
  owners: ReadonlyMap<string, SessionOwner>,
): WindowSpend | null {
  const spend: WindowSpend = { total: 0, agents: new Map(), unowned: 0 };
  for (const [sessionId, points] of sessions) {
    const cost = points.reduce(
      (sum, point) => (point.timestampMs >= start ? sum + point.cost : sum),
      0,
    );
    if (cost === 0) continue;
    spend.total += cost;

    const owner = owners.get(sessionId);
    const agent = owner && spend.agents.get(owner.agentId);
    if (agent) agent.cost += cost;
    else if (owner) spend.agents.set(owner.agentId, { title: owner.title, cost });
    else spend.unowned += cost;
  }
  return spend.total > 0 ? spend : null;
}

/**
 * A row for each window's top agents, by share of the first window then the next, and one for the
 * rest. No rows when no agent spent anything.
 */
export function spendDetails(windows: readonly ShareWindow[]): UsageDetail[] {
  const spent = windows.flatMap(({ name, spend }) => (spend ? [{ name, spend }] : []));
  // Titles by agent id.
  const shown = new Map(spent.flatMap(({ spend }) => topAgents(spend)));
  if (shown.size === 0) return [];

  const shares = (cost: (spend: WindowSpend) => number): number[] =>
    spent.map(({ spend }) => cost(spend) / spend.total);
  const rows: ShareRow[] = [...shown].map(([agentId, title]) => ({
    id: `spend_${agentId}`,
    title,
    shares: shares((spend) => spend.agents.get(agentId)?.cost ?? 0),
  }));
  rows.sort(byShares);
  const rest = shares((spend) => restCost(spend, shown));
  if (rest.some((share) => share > 0))
    rows.push({ id: "spend_other", title: "Others", shares: rest });

  return rows.map((row) => ({
    id: row.id,
    label: `Spend · ${row.title}`,
    value: spent.map(({ name }, index) => `${percent(row.shares[index])} ${name}`).join(" · "),
  }));
}

function topAgents(spend: WindowSpend): [agentId: string, title: string][] {
  return [...spend.agents]
    .sort(([, a], [, b]) => b.cost - a.cost)
    .slice(0, TOP_PER_WINDOW)
    .map(([agentId, agent]) => [agentId, agent.title]);
}

function byShares(a: ShareRow, b: ShareRow): number {
  for (const [index, share] of a.shares.entries()) {
    const difference = b.shares[index] - share;
    if (difference !== 0) return difference;
  }
  return a.title.localeCompare(b.title);
}

/** What the window's spend outside the shown agents comes to. */
function restCost(spend: WindowSpend, shown: ReadonlyMap<string, string>): number {
  let cost = spend.unowned;
  for (const [agentId, agent] of spend.agents) {
    if (!shown.has(agentId)) cost += agent.cost;
  }
  return cost;
}

function percent(share: number): string {
  if (share > 0 && share < 0.01) return "<1%";
  return `${Math.round(share * 100)}%`;
}
