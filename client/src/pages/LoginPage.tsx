import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useAuth } from "../hooks/useAuth";
import { useTranslation } from "react-i18next";

export default function LoginPage() {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { refresh } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.auth.login({ username, password });
      await refresh();
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("auth.loginFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-page">
      <div className="w-[360px] rounded-2xl border border-border bg-surface p-10 shadow-card">
        <h1 className="font-serif text-2xl font-semibold text-ink">MemoryLane</h1>
        <p className="mt-2 text-sm text-muted">{t("auth.intro")}</p>
        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3.5">
          <label className="flex flex-col gap-1.5 text-sm text-muted">
            {t("auth.username")}
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
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
              className="rounded-lg border border-border bg-page px-3 py-2.5 text-ink outline-none focus:border-accent"
            />
          </label>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="mt-2 rounded-lg bg-accent px-4 py-3 font-semibold text-page transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? t("auth.signingIn") : t("auth.signIn")}
          </button>
        </form>
      </div>
    </div>
  );
}
