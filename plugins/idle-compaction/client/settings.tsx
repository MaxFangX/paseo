import { useCallback, useMemo, useRef } from "react";
import { Text } from "react-native";
import { useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { idleCompactionSettings } from "../shared/settings.js";

type Ready = Extract<SettingsState<typeof idleCompactionSettings.schema>, { status: "ready" }>;

function Controls({ settings }: { settings: Ready }) {
  const idleMinutes = useRef(String(settings.values.idleMinutes));
  const thresholdTokens = useRef(String(settings.values.thresholdTokens));
  const changeEnabled = useCallback(
    (enabled: boolean) => void settings.save({ ...settings.values, enabled }, settings.revision),
    [settings],
  );
  const changeIdleMinutes = useCallback((text: string) => {
    idleMinutes.current = text;
  }, []);
  const changeThresholdTokens = useCallback((text: string) => {
    thresholdTokens.current = text;
  }, []);
  // The host validates the numbers and reports a rejected save through saveError.
  const save = useCallback(
    () =>
      void settings.save(
        {
          ...settings.values,
          idleMinutes: Number(idleMinutes.current),
          thresholdTokens: Number(thresholdTokens.current),
        },
        settings.revision,
      ),
    [settings],
  );
  return (
    <SettingsCard>
      <SettingsSwitch
        label="Compact idle Claude agents"
        hint="Before the prompt cache expires, so the next message re-writes a small context"
        value={settings.values.enabled}
        disabled={settings.saving}
        onValueChange={changeEnabled}
      />
      <SettingsInput
        label="Minutes after a turn ends"
        hint="Claude's prompt cache lasts 60"
        initialValue={idleMinutes.current}
        disabled={settings.saving}
        onChangeText={changeIdleMinutes}
      />
      <SettingsInput
        label="Only above this many context tokens"
        initialValue={thresholdTokens.current}
        disabled={settings.saving}
        error={settings.saveError}
        onChangeText={changeThresholdTokens}
      />
      <SettingsAction
        label="Idle time and threshold"
        actionLabel="Save"
        disabled={settings.saving}
        onPress={save}
      />
    </SettingsCard>
  );
}

export function IdleCompactionScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(idleCompactionSettings);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  let content = <Text style={style}>Loading settings…</Text>;
  if (settings.status === "ready") content = <Controls settings={settings} />;
  else if (settings.status !== "loading")
    content = (
      <SettingsCard>
        <Text style={style}>{settings.error}</Text>
        <SettingsAction label="Restore the defaults" actionLabel="Reset" onPress={settings.reset} />
      </SettingsCard>
    );
  return <SettingsSection title="Idle compaction">{content}</SettingsSection>;
}
