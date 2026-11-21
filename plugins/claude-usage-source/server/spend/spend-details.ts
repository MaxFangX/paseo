import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginHookContext, UsageReport, UsageWindow } from "@getpaseo/plugin/server";
import type { UsageInput } from "../../shared/input.js";
import { SESSION_WINDOW_MS, WEEKLY_WINDOW_MS } from "../run-out.js";
import { claudeKeychainRoute } from "../usage.js";
import { spendDetails, windowSpend, type SessionOwner } from "./spend-share.js";
import { TranscriptSpend, type SpendPoint } from "./transcript-spend.js";

// PATCH(usage-spend-share): appends each Paseo agent's share of a Claude login's spend to its
// usage report. Reading a week of transcripts takes seconds, so a report shows the last scan's
// shares and starts the next scan in the background.

type Paseo = PluginHookContext["paseo"];

interface SpendDetailsOptions {
  /** The daemon connection, once a hook has carried one; no rows without it. */
  paseo: () => Paseo | undefined;
  log: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

interface WindowStarts {
  session?: number;
  weekly?: number;
}

interface Scanned {
  sessions: Map<string, SpendPoint[]>;
  owners: Map<string, SessionOwner>;
}

/** One Claude home's transcripts and its last completed scan. */
interface HomeSpend {
  transcripts: TranscriptSpend;
  scanning: boolean;
  last: Scanned | null;
  /** A scan has completed; the first one logs its time. */
  scanned: boolean;
  /** The failure since the last completed scan is logged. */
  failureLogged: boolean;
}

const PAGE_LIMIT = 200;

export interface SpendDetails {
  /** Adds share rows from the last scan of the login's Claude home, and starts the next one. */
  append(report: UsageReport, input: UsageInput): UsageReport;
}

export function createSpendDetails(options: SpendDetailsOptions): SpendDetails {
  const homes = new Map<string, HomeSpend>();

  async function scan(state: HomeSpend, since: number, paseo: Paseo): Promise<void> {
    const startedAt = performance.now();
    try {
      const stats = await state.transcripts.scan(since);
      state.last = { sessions: state.transcripts.bySession(), owners: await sessionOwners(paseo) };
      if (!state.scanned) {
        const ms = Math.round(performance.now() - startedAt);
        options.log(`Claude spend: first scan read ${stats.files} transcripts in ${ms} ms`);
      }
      state.scanned = true;
      state.failureLogged = false;
    } catch (error) {
      state.last = null;
      if (!state.failureLogged) options.log(`Claude spend: scan failed: ${String(error)}`);
      state.failureLogged = true;
    } finally {
      state.scanning = false;
    }
  }

  return {
    append(report, input) {
      if (report.status !== "available") return report;
      const home = claudeHome(input, options.env, options.home);
      const paseo = options.paseo();
      const starts = windowStarts(report.windows);
      const since = starts.weekly ?? starts.session;
      if (!home || !paseo || since === undefined) return report;

      let state = homes.get(home);
      if (!state) {
        const transcripts = new TranscriptSpend(home);
        state = { transcripts, scanning: false, last: null, scanned: false, failureLogged: false };
        homes.set(home, state);
      }
      if (!state.scanning) {
        state.scanning = true;
        void scan(state, since, paseo);
      }

      const rows = state.last ? shareRows(state.last, starts) : [];
      return rows.length ? { ...report, details: [...(report.details ?? []), ...rows] } : report;
    },
  };
}

function shareRows({ sessions, owners }: Scanned, starts: WindowStarts) {
  const spend = (start: number | undefined) =>
    start === undefined ? null : windowSpend(sessions, start, owners);
  return spendDetails([
    { name: "session", spend: spend(starts.session) },
    { name: "week", spend: spend(starts.weekly) },
  ]);
}

/** Each window's start, from its reset; a window with no reset has none. */
function windowStarts(windows: readonly UsageWindow[]): WindowStarts {
  const start = (id: string, windowMs: number) => {
    const resetsAt = windows.find((window) => window.id === id)?.resetsAt;
    const reset = resetsAt ? Date.parse(resetsAt) : Number.NaN;
    return Number.isNaN(reset) ? undefined : reset - windowMs;
  };
  return {
    session: start("five_hour", SESSION_WINDOW_MS),
    weekly: start("weekly", WEEKLY_WINDOW_MS),
  };
}

/**
 * The Claude Code home whose transcripts a login's spend is in. Null for a login another harness
 * holds, or a Keychain entry for a config directory this process does not know.
 */
export function claudeHome(
  input: UsageInput,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | null {
  const route = input.route;
  if (route.store === "claude") return dirname(route.path);
  if (route.store !== "keychain") return null;

  const service = (configDir?: string) =>
    claudeKeychainRoute({ env: { CLAUDE_CONFIG_DIR: configDir } }).service;
  if (route.service === undefined || route.service === service()) return join(home, ".claude");
  const configDir = env.CLAUDE_CONFIG_DIR;
  return configDir && route.service === service(configDir) ? configDir : null;
}

/** The agent running each Claude session, archived agents included. */
export async function sessionOwners(paseo: Paseo): Promise<Map<string, SessionOwner>> {
  const owners = new Map<string, SessionOwner>();
  let cursor: string | undefined;
  do {
    const { entries, pageInfo } = await paseo.agents.list({
      filter: { includeArchived: true, includeBackground: true },
      page: { limit: PAGE_LIMIT, cursor },
    });
    for (const { agent } of entries) {
      const sessionId = agent.persistence?.sessionId;
      // An untitled agent goes by its short id, as elsewhere in Paseo.
      const title = agent.title?.trim() || agent.id.slice(0, 7);
      if (sessionId) owners.set(sessionId, { agentId: agent.id, title });
    }
    cursor = (pageInfo.hasMore && pageInfo.nextCursor) || undefined;
  } while (cursor);
  return owners;
}
