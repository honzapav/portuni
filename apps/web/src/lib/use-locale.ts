import { useTranslation } from "react-i18next";

// The UI language, for the functions in lib/format.ts. Re-renders the
// caller when the language changes.
export function useLocale(): string {
  return useTranslation().i18n.language;
}
