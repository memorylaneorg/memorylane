import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useAuth } from "../hooks/useAuth";
import { useTranslation } from "react-i18next";

export default function SetupPage() {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const { refresh } = useAuth();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError(t("auth.passwordsMismatch"));
      return;
    }
    setSubmitting(true);
    try {
      await api.auth.setup({ username, password });
      // App.tsx routes "/login" back to "/setup" while needsSetup is true -
      // that flag lives in AuthProvider's state from the initial page load,
      // so it has to be refreshed here or the navigate below just bounces
      // straight back to this page instead of reaching the login screen.
      await refresh();
      // Setup deliberately logs the user out - they must log in again.
      navigate("/login", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("auth.setupFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-page">
      <div className="w-[360px] rounded-2xl border border-border bg-surface p-10 shadow-card">
        <h1 className="font-serif text-2xl font-semibold text-ink">{t("auth.welcome")}</h1>
        <p className="mt-2 text-sm text-muted">{t("auth.intro")}</p>
        <p className="mt-1 text-sm text-muted">{t("auth.setupAccount")}</p>
        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3.5">
          <label className="flex flex-col gap-1.5 text-sm text-muted">
            {t("auth.username")}
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              minLength={3}
              autoFocus
              className="rounded-lg border border-border bg-page px-3 py-2.5 text-ink outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm text-muted">
            {t("auth.password")}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              className="rounded-lg border border-border bg-page px-3 py-2.5 text-ink outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm text-muted">
            {t("auth.confirmPassword")}
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={8}
              className="rounded-lg border border-border bg-page px-3 py-2.5 text-ink outline-none focus:border-accent"
            />
          </label>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="mt-2 rounded-lg bg-accent px-4 py-3 font-semibold text-page transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? t("auth.creating") : t("auth.createAccount")}
          </button>
        </form>
      </div>
    </div>
  );
}
