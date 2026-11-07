// PATCH(queue-tooltips): fork-only module.
//
// The queued-row icon buttons (edit, steer, send now) are told apart only by their screen-reader
// labels, so each one names its action in a hover tooltip. Desktop only, like the composer's other
// button tooltips.
import type { ReactElement } from "react";
import { Text, type PressableProps } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { SendBehavior } from "@/hooks/use-settings";

export function QueueActionButton({
  tooltip,
  ...props
}: PressableProps & { tooltip: string }): ReactElement {
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      {/* The trigger is the button, like the composer's cancel button. */}
      <TooltipTrigger {...props} />
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltip}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

/** Send-now interrupts a running turn unless Default send steers; an idle agent just gets it. */
export function sendNowTooltipKey(sendBehavior: SendBehavior, isAgentRunning: boolean) {
  if (!isAgentRunning) return "composer.attachments.sendQueuedMessageNow" as const;
  return sendBehavior === "steer"
    ? ("composer.attachments.steerQueuedMessageNow" as const)
    : ("composer.attachments.interruptQueuedMessageNow" as const);
}

const styles = StyleSheet.create((theme) => ({
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
}));
