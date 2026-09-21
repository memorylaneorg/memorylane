# UI localization

MemoryLane's browser UI uses `i18next` and `react-i18next`. English (`en`) is the source and fallback language; Spanish (`es`) and French (`fr`) ship with the client. Translation is client-only: server logs and API error messages remain English.

Translation resources live in `client/src/i18n/resources`. Use semantic keys grouped by UI area, call `useTranslation()` in React components, and use `t(key, values)` for interpolation and plural counts. Use `<Trans>` only when a sentence contains React elements.

The language selector is in Settings and offers the system language or an explicit choice. The preference is stored in the browser so it also applies to setup and sign-in screens. `client/src/i18n/index.ts` updates the document language and falls back to English for unsupported browser languages.

Locale-sensitive dates and numbers should use the helpers in `client/src/utils/format.ts` or `Intl` with `i18n.resolvedLanguage`; do not manually construct English plurals. Filenames, paths, tags, camera/lens names, EXIF values, and plugin-provided names are user or device data and should not be translated.

Run `npm test --workspace=client` after editing resources. The parity test rejects missing or extra keys and mismatched interpolation placeholders. Then run `npm run typecheck --workspace=client` and `npm run build --workspace=client`.
