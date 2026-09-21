// Shared by the API wrapper and the page indicator, including requests made
// before the indicator mounts (such as the initial authentication check).
let pendingReads = 0;

export function trackPageRead(): () => void {
  pendingReads++;
  return () => { pendingReads--; };
}

export function hasPendingPageReads(): boolean {
  return pendingReads > 0;
}
