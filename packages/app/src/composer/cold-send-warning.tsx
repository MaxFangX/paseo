// PATCH(cold-send): fork-only module.
//
// Above the input of a Claude agent whose prompt cache went cold with a large context: the next
// send re-writes that whole context at the cache-write price, twice the input price, unless the
// agent is compacted first. See utils/cache-state.ts.
import { useCallback, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { useCacheState } from "@/hooks/use-cache-state";
import { useSessionStore } from "@/stores/session-store";
import { cacheStateInput, isLargeContext } from "@/utils/cache-state";

export function ColdSendWarning({
  serverId,
  agentId,
  onSend,
}: {
  serverId: string;
  agentId: string;
  /** Sends a message without touching the draft. */
  onSend: (text: string, attachments: []) => Promise<void>;
}): ReactElement | null {
  const toast = useToast();
  const [compacting, setCompacting] = useState(false);
  const agent = useSessionStore((state) => state.sessions[serverId]?.agents.get(agentId));
  const input = agent ? cacheStateInput(agent) : null;
  const state = useCacheState(input);
  const compact = useCallback(() => {
    setCompacting(true);
    onSend("/compact", [])
      .catch((error) => toast.error(error instanceof Error ? error.message : String(error)))
      .finally(() => setCompacting(false));
  }, [onSend, toast]);

  const usedTokens = input?.usedTokens;
  if (state?.kind !== "cold" || !isLargeContext(usedTokens)) return null;

  return (
    <View style={styles.row} testID="cold-send-warning">
      <Text style={styles.text} numberOfLines={1}>
        {`Cold, ${formatTokenCount(usedTokens)}: sending re-writes it at 2x`}
      </Text>
      <Button variant="outline" size="xs" loading={compacting} onPress={compact}>
        Compact first
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    // On the input's text rails: the border and padding of inputWrapper in input/input.tsx.
    paddingHorizontal: {
      xs: theme.borderWidth[1] + theme.spacing[3],
      md: theme.borderWidth[1] + theme.spacing[4],
    },
  },
  text: {
    flex: 1,
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
  },
}));
