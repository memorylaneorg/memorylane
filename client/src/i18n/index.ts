import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./resources/en";
import { es } from "./resources/es";
import { fr } from "./resources/fr";

export const LANGUAGE_STORAGE_KEY = "memorylane-language";
export const supportedLanguages = ["en", "es", "fr"] as const;
export type SupportedLanguage = (typeof supportedLanguages)[number];

function browserLanguage(): SupportedLanguage {
  const base = (typeof navigator === "undefined" ? "en" : navigator.language).toLowerCase().split("-")[0];
  return supportedLanguages.includes(base as SupportedLanguage) ? base as SupportedLanguage : "en";
}

function initialLanguage(): SupportedLanguage {
  const saved = typeof localStorage === "undefined" ? null : localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return supportedLanguages.includes(saved as SupportedLanguage) ? saved as SupportedLanguage : browserLanguage();
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, es: { translation: es }, fr: { translation: fr } },
  lng: initialLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnNull: false,
});

function applyDocumentLanguage(language: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = language;
  document.documentElement.dir = "ltr";
}

applyDocumentLanguage(i18n.resolvedLanguage ?? i18n.language);
i18n.on("languageChanged", applyDocumentLanguage);

export async function setLanguage(language: SupportedLanguage | "system"): Promise<void> {
  if (language === "system") {
    if (typeof localStorage !== "undefined") localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    await i18n.changeLanguage(browserLanguage());
  } else {
    if (typeof localStorage !== "undefined") localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    await i18n.changeLanguage(language);
  }
}

export function languagePreference(): SupportedLanguage | "system" {
  const saved = typeof localStorage === "undefined" ? null : localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return supportedLanguages.includes(saved as SupportedLanguage) ? saved as SupportedLanguage : "system";
}

export default i18n;
