// PATCH(steer-delivery): fork-only module.
//
// Steers the agent has not read yet, above the queue track: they reach the agent before anything
// queued, and their transcript rows appear once it reads them. See pending-steers.ts.
import type { ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { CornerDownRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { usePendingSteers } from "./pending-steers";

export function PendingSteerTrack({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const steers = usePendingSteers(serverId, agentId);
  if (steers.length === 0) return null;
  return (
    <View style={styles.track}>
      {steers.map((steer) => (
        <View
          key={steer.clientMessageId}
          style={styles.row}
          accessible
          accessibilityLabel={t("composer.attachments.pendingSteerLabel", { text: steer.text })}
        >
          <ThemedCornerDownRight size={ICON_SIZE.sm} uniProps={iconMutedMapping} />
          <Text style={styles.text} numberOfLines={2} ellipsizeMode="tail">
            {steer.text}
          </Text>
          <Text style={styles.status}>{t("composer.attachments.pendingSteerStatus")}</Text>
        </View>
      ))}
    </View>
  );
}

const iconMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedCornerDownRight = withUnistyles(CornerDownRight);

// Mirrors the composer's queue rows (`queueTrack` and `queueItem` in index.tsx).
const styles = StyleSheet.create((theme) => ({
  track: {
    flexDirection: "column",
    gap: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    gap: theme.spacing[2],
  },
  text: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  status: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
