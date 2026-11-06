import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSection, SettingsSelect } from "@/components/settings";
import { useAppSettings, type SendBehavior } from "@/hooks/use-settings";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages"; // PATCH(queue-steer)

const SEND_BEHAVIORS: readonly SendBehavior[] = ["interrupt", "steer", "queue"];
const QUEUE_MODIFIER_SENDS: readonly ActiveTurnBehavior[] = ["interrupt", "steer"]; // PATCH(queue-steer)

export function SendingSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const options = useMemo(
    () =>
      SEND_BEHAVIORS.map((value) => ({
        value,
        label: t(`settings.general.defaultSend.options.${value}`),
      })),
    [t],
  );
  const change = useCallback(
    (sendBehavior: SendBehavior) => void updateSettings({ sendBehavior }),
    [updateSettings],
  );
  // PATCH(queue-steer): only queue mode has a modifier send to configure.
  const queueModifierOptions = useMemo(
    () =>
      QUEUE_MODIFIER_SENDS.map((value) => ({
        value,
        label: t(`settings.general.queueModifierSend.options.${value}`),
      })),
    [t],
  );
  const changeQueueModifier = useCallback(
    (queueModifierSend: ActiveTurnBehavior) => void updateSettings({ queueModifierSend }),
    [updateSettings],
  );
  return (
    <SettingsSection title={t("settings.general.sending")}>
      <SettingsCard>
        <SettingsSelect
          label={t("settings.general.defaultSend.label")}
          hint={t(`settings.general.defaultSend.descriptions.${settings.sendBehavior}`)}
          value={settings.sendBehavior}
          options={options}
          onValueChange={change}
        />
        {/* PATCH(queue-steer) */}
        {settings.sendBehavior === "queue" ? (
          <SettingsSelect
            label={t("settings.general.queueModifierSend.label")}
            hint={t("settings.general.queueModifierSend.description")}
            value={settings.queueModifierSend}
            options={queueModifierOptions}
            onValueChange={changeQueueModifier}
          />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
