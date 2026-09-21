import { useNavigate } from "react-router-dom";
import ScanFoldersManager from "../components/ScanFoldersManager";
import { useTranslation } from "react-i18next";

// Step 1 of the welcome flow: a generic intro plus the same full folder
// management UI Settings uses (add/remove/reorder/enable/scan-now) - see
// ScanFoldersManager. Adding a folder here is optional (you can always do it
// later from Settings), so "Continue" is never blocked on having one.
export default function WelcomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <main className="mx-auto min-h-screen max-w-3xl space-y-8 px-6 py-12 text-ink">
      <div>
        <p className="text-sm text-muted">{t("onboarding.step1")}</p>
        <h1 className="text-3xl font-semibold">{t("onboarding.welcome")}</h1>
        <p className="mt-2 text-muted">
          {t("onboarding.intro")}
        </p>
      </div>
      <section>
        <h2 className="mb-1 font-serif text-lg font-semibold text-ink">{t("onboarding.addFolders")}</h2>
        <p className="mb-3 text-sm text-muted">
          {t("onboarding.foldersHelp")}
        </p>
        <ScanFoldersManager showTranscodeNudge={false} />
      </section>
      <button
        type="button"
        onClick={() => navigate("/welcome/plugins")}
        className="rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white hover:opacity-90"
      >
        {t("common.continue")}
      </button>
    </main>
  );
}
