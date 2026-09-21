export const PLUGIN_LIFECYCLE_STATES = [
  "available",
  "downloading",
  "installed",
  "starting",
  "ready",
  "failed",
  "update-available",
  "disabled",
  "incompatible",
] as const;

export type PluginLifecycleState = (typeof PLUGIN_LIFECYCLE_STATES)[number];

export interface PluginInventoryItem {
  id: string;
  name: string;
  description: string;
  version: string | null;
  state: PluginLifecycleState;
  required: boolean;
  capabilities: string[];
  // Human-readable names of plugins this one depends on (e.g. "AI Runtime"),
  // resolved from the manifest's dependency ids - installing/enabling this
  // plugin will silently pull those in too. Empty when it has none.
  dependsOn: string[];
  error: string | null;
}
