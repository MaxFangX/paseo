import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const idleCompactionSettings = defineSettings({
  id: "idle-compaction",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
    /** Minutes after a turn ends. Past the cache's lifetime, a compaction re-writes the context. */
    idleMinutes: z.number().int().min(1).default(50),
    /** An agent is compacted only when its context is larger than this. */
    thresholdTokens: z.number().int().min(0).default(150_000),
  }),
});

export type IdleCompactionSettings = z.infer<typeof idleCompactionSettings.schema>;
