import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { useConfirm } from "./ConfirmDialog";
import { CORE_UPDATE_REFRESH_EVENT } from "./CoreUpdateBanner";

interface CheckForUpdatesButtonProps {
  disabled?: boolean;
  onChecked?: () => void | Promise<void>;
  onCheckingChange?: (checking: boolean) => void;
}

export default function CheckForUpdatesButton({ disabled = false, onChecked, onCheckingChange }: CheckForUpdatesButtonProps) {
  const { t } = useTranslation();
  const { notice } = useConfirm();
  const [checking, setChecking] = useState(false);

  const check = async () => {
    setChecking(true);
    onCheckingChange?.(true);
    try {
      await Promise.all([api.pluginPlatform.checkUpdates(), api.coreUpdate.check()]);
      window.dispatchEvent(new Event(CORE_UPDATE_REFRESH_EVENT));
      await onChecked?.();
    } catch (cause) {
      await notice({
        title: t("pluginUi.updateFailed"),
        message: cause instanceof Error ? cause.message : t("pluginUi.genericError"),
      });
    } finally {
      setChecking(false);
      onCheckingChange?.(false);
    }
  };

  return (
    <button
      type="button"
      className="rounded-md border border-border px-3 py-1.5 text-sm text-ink hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
      disabled={disabled || checking}
      onClick={() => void check()}
    >
      {t("pluginUi.checkUpdates")}
    </button>
  );
}
