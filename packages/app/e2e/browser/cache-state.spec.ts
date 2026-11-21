// PATCH(cache-state): fork-only spec.
//
// The harness runs mock-provider agents, and the badge tracks Claude's prompt cache. So the app is
// told on the wire that each seeded agent is a Claude agent with a given context, and a fixed
// browser clock, set against the end of turn the daemon recorded, makes its cache warm or cold.
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import {
  composerLocator,
  expectComposerDraft,
  expectComposerVisible,
  fillComposerDraft,
} from "../support/helpers/composer";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import {
  type MockAgentWorkspace,
  openAgentRoute,
  seedMockAgentWorkspace,
} from "../support/helpers/mock-agent";
import { expectNoTruncation } from "../support/helpers/no-truncation";
import { getServerId } from "../support/helpers/server-id";

const MINUTE = 60_000;
const DESKTOP = { width: 1440, height: 900 };
const COMPACT = { width: 390, height: 844 };
const LARGE_CONTEXT = { contextWindowUsedTokens: 412_000, contextWindowMaxTokens: 1_000_000 };
// Fits the wide sidebar's row, but not beside a badge.
const LONG_NAME = "Keep context usage across restarts";

type ContextUsage = typeof LARGE_CONTEXT;

interface FinishedAgent extends MockAgentWorkspace {
  lastTurnEndedAt: number;
}

interface FinishedSnapshot {
  status: string;
  lastTurnEndedAt?: string | null;
}

/** A mock agent whose first turn has ended; its 32k context is the mock's own report. */
async function seedFinishedAgent(repoPrefix: string): Promise<FinishedAgent> {
  const agent = await seedMockAgentWorkspace({
    repoPrefix,
    title: "Cache state e2e",
    initialPrompt: "emit 32000 byte file agent stream payload",
  });
  const snapshot = (await agent.client.waitForAgentUpsert(
    agent.agentId,
    (state) => state.status === "idle" && Boolean((state as FinishedSnapshot).lastTurnEndedAt),
    30_000,
  )) as FinishedSnapshot;
  return { ...agent, lastTurnEndedAt: Date.parse(snapshot.lastTurnEndedAt!) };
}

/** Tells the app each listed agent is a Claude agent, with the given context if one is listed. */
async function reportAsClaude(page: Page, agents: Map<string, ContextUsage | null>) {
  const ids = [...agents.keys()];
  const patch = (value: unknown) => {
    if (!isAgentSnapshot(value) || !agents.has(value.id)) return value;
    const usage = agents.get(value.id);
    return {
      ...value,
      provider: "claude",
      ...(usage ? { lastUsage: { ...value.lastUsage, ...usage } } : {}),
    };
  };
  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const mentioned = typeof message === "string" && ids.some((id) => message.includes(id));
      ws.send(mentioned ? JSON.stringify(JSON.parse(message, (_key, v) => patch(v))) : message);
    });
  });
}

function isAgentSnapshot(
  value: unknown,
): value is { id: string; provider: string; lastUsage?: object } {
  const record = value as { id?: unknown; provider?: unknown } | null;
  return typeof record?.id === "string" && typeof record.provider === "string";
}

async function openAgent(page: Page, agent: FinishedAgent, minutesAfterTurn: number) {
  await page.clock.setFixedTime(agent.lastTurnEndedAt + minutesAfterTurn * MINUTE);
  await openAgentRoute(page, agent);
  await expectComposerVisible(page);
}

/** The warning starts where the input's text does. */
async function expectOnInputTextRail(page: Page, warning: Locator) {
  const rail = await composerLocator(page).evaluate((input) => {
    const style = getComputedStyle(input);
    const inset = Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft);
    return input.getBoundingClientRect().left + inset;
  });
  const text = await warning.getByText(/^Cold,/).boundingBox();
  expect(text?.x).toBeCloseTo(rail, 0);
}

/** The composer's badge centres on the meter beside it. */
async function expectCentredOnMeter(page: Page) {
  const badge = await page.getByTestId("agent-cache-state").boundingBox();
  const meter = await page.getByTestId("context-window-meter").boundingBox();
  if (!badge || !meter) throw new Error("Could not measure the badge and the meter");
  expect(badge.y + badge.height / 2).toBeCloseTo(meter.y + meter.height / 2, 0);
}

function sidebarRow(page: Page, agent: FinishedAgent): Locator {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${agent.workspaceId}`).first();
}

/** Whether the row's badge sits on its name's line, rather than clipped below it. */
async function badgeBesideName(row: Locator, name: string): Promise<boolean> {
  const nameBox = await row.getByText(name, { exact: true }).boundingBox();
  const badgeBox = await row.getByTestId("workspace-cache-state").boundingBox();
  if (!nameBox || !badgeBox) throw new Error(`Could not measure the row named ${name}`);
  return badgeBox.y < nameBox.y + nameBox.height;
}

async function expectSidebarRows(large: Locator, small: Locator, badge: string) {
  await expect(large.getByTestId("workspace-cache-state")).toHaveText(badge);
  await expectNoTruncation(large);
  await expectNoTruncation(small);
  expect(await badgeBesideName(large, "main")).toBe(true);
}

/** Saves a shot of the page, or of the region around `around`, when QA screenshots are on. */
async function shot(page: Page, name: string, around: Locator[] = [], pad = 24) {
  const directory = process.env.PASEO_QA_SCREENSHOT_DIR;
  if (!directory) return;
  await page.addStyleTag({ content: ".__expo_fast_refresh { display: none !important; }" });
  const boxes = await Promise.all(around.map((locator) => locator.boundingBox()));
  const clip = boxes.reduce<{ x: number; y: number; width: number; height: number } | undefined>(
    (union, box) => {
      if (!box) return union;
      const x = Math.max(0, Math.min(union?.x ?? Infinity, box.x - pad));
      const y = Math.max(0, Math.min(union?.y ?? Infinity, box.y - pad));
      const right = Math.max(union ? union.x + union.width : 0, box.x + box.width + pad);
      const bottom = Math.max(union ? union.y + union.height : 0, box.y + box.height + pad);
      return { x, y, width: right - x, height: bottom - y };
    },
    undefined,
  );
  await page.screenshot({ path: path.join(directory, `${name}.png`), clip });
}

test.describe("cache state", () => {
  let large: FinishedAgent;
  let small: FinishedAgent;

  test.beforeAll(async () => {
    large = await seedFinishedAgent("cache-state-large-");
    small = await seedFinishedAgent("cache-state-small-");
    await small.client.setWorkspaceTitle(small.workspaceId, LONG_NAME);
  });

  test.afterAll(async () => {
    await large?.cleanup();
    await small?.cleanup();
  });

  test.beforeEach(async ({ page }) => {
    await reportAsClaude(
      page,
      new Map([
        [large.agentId, LARGE_CONTEXT],
        [small.agentId, null],
      ]),
    );
  });

  test("the composer and sidebar show the cache, and warn before a large cold send", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(DESKTOP);
    const badge = page.getByTestId("agent-cache-state");
    const warning = page.getByTestId("cold-send-warning");
    const input = composerLocator(page);
    const rows = [sidebarRow(page, large), sidebarRow(page, small)] as const;

    await openAgent(page, large, 22);
    await expect(badge).toHaveText("412k · 38m", { timeout: 30_000 });
    await expectCentredOnMeter(page);
    await expect(warning).toHaveCount(0);
    await expectSidebarRows(...rows, "412k · 38m");
    // The badge gives way to a name that needs the room.
    expect(await badgeBesideName(rows[1], LONG_NAME)).toBe(false);
    const inputBefore = await input.boundingBox();
    await shot(page, "warm-composer", [input], 64);
    await shot(page, "sidebar-wide", [...rows]);
    await rows[0].hover();
    await shot(page, "sidebar-wide-hover", [...rows]);

    await openAgent(page, small, 90);
    await expect(badge).toHaveText("32k · cold", { timeout: 30_000 });
    await expect(warning).toHaveCount(0);
    await shot(page, "cold-small-composer", [input], 64);

    await openAgent(page, large, 90);
    await expect(badge).toHaveText("412k · cold", { timeout: 30_000 });
    await expect(warning).toHaveText(/^Cold, 412k: sending re-writes it at 2x/);
    await expectOnInputTextRail(page, warning);
    // The row grows the composer upward; the input keeps its place and size.
    expect(await input.boundingBox()).toEqual(inputBefore);
    await shot(page, "cold-large-composer", [warning, input], 64);
    await shot(page, "cold-large-page");

    await fillComposerDraft(page, "Unrelated follow-up");
    await warning.getByRole("button", { name: "Compact first" }).click();
    await expect(page.getByTestId("user-message").filter({ hasText: "/compact" })).toHaveCount(1);
    await expectComposerDraft(page, "Unrelated follow-up");
  });

  test("the compact layout shows the cache in the composer and sidebar", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(COMPACT);
    await openAgent(page, large, 90);
    await expect(page.getByTestId("agent-cache-state")).toHaveText("412k · cold", {
      timeout: 30_000,
    });
    const warning = page.getByTestId("cold-send-warning");
    await expectCentredOnMeter(page);
    await expectOnInputTextRail(page, warning);
    await shot(page, "compact-composer", [warning, composerLocator(page)], 64);

    await page.getByTestId("menu-button").click();
    const rows = [sidebarRow(page, large), sidebarRow(page, small)] as const;
    await expectSidebarRows(...rows, "412k · cold");
    await shot(page, "sidebar-compact", [...rows]);
  });
});
