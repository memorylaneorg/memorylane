import { useEffect, useState } from "react";
import type { PluginPlatformDto } from "@memorylane/shared";
import { api } from "../api/client";

// "ready" only applies to service-kind plugins (spawned as a supervised
// child process - see server/src/plugin-platform/service-supervisor.ts). A
// module-kind plugin (e.g. ai-search, people) is loaded in-process and can
// never satisfy that check, so its enabled/healthy steady state is
// "installed" instead. Checking only for "ready" leaves module-kind plugins
// looking permanently un-enabled even once they're fully on - use this
// everywhere the UI needs to know "is this plugin actually active right now".
export function isPluginActive(item: Pick<PluginPlatformDto, "state">): boolean {
  return item.state === "ready" || item.state === "installed";
}

// Starts false (not "unknown") - callers gate a feature's UI on this, and
// hiding it for the one fetch round-trip on mount is preferable to briefly
// showing controls for a plugin that turns out not to be installed.
export function usePluginActive(pluginId: string): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void api.pluginPlatform.list().then((items) => {
      if (!cancelled) setActive(items.some((item) => item.id === pluginId && isPluginActive(item)));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [pluginId]);
  return active;
}
