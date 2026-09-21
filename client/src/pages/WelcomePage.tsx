import { useNavigate } from "react-router-dom";
import ScanFoldersManager from "../components/ScanFoldersManager";

// Step 1 of the welcome flow: a generic intro plus the same full folder
// management UI Settings uses (add/remove/reorder/enable/scan-now) - see
// ScanFoldersManager. Adding a folder here is optional (you can always do it
// later from Settings), so "Continue" is never blocked on having one.
export default function WelcomePage() {
  const navigate = useNavigate();
  return (
    <main className="mx-auto min-h-screen max-w-3xl space-y-8 px-6 py-12 text-ink">
      <div>
        <p className="text-sm text-muted">MemoryLane setup · Step 1 of 2</p>
        <h1 className="text-3xl font-semibold">Welcome to MemoryLane</h1>
        <p className="mt-2 text-muted">
          The fastest way to resurface old photos and videos and see everything you have in one place - all on your own machine, over your own
          files. Nothing is uploaded anywhere.
        </p>
      </div>
      <section>
        <h2 className="mb-1 font-serif text-lg font-semibold text-ink">Add your photo folders</h2>
        <p className="mb-3 text-sm text-muted">
          Point MemoryLane at the folders where your photos and videos already live. It only reads them - nothing is modified, renamed, or moved.
          You can add, remove, or change these anytime later from Settings, and skip this for now if you'd rather browse first.
        </p>
        <ScanFoldersManager showTranscodeNudge={false} />
      </section>
      <button
        type="button"
        onClick={() => navigate("/welcome/plugins")}
        className="rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white hover:opacity-90"
      >
        Continue
      </button>
    </main>
  );
}
