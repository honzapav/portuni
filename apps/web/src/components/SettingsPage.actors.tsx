// Re-exports the existing actors page so SettingsPage can render it as
// a sub-tab. Kept as a separate file so the lazy import in SettingsPage
// can still code-split cytoscape away from the settings bundle.
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

const ActorsPage = lazy(() => import("./ActorsPage"));

export default function SettingsActorsPanel() {
  const { t } = useTranslation("settings");
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-[14px] text-[var(--color-text-dim)]">
          {t(($) => $.page.actors_loading)}
        </div>
      }
    >
      <ActorsPage />
    </Suspense>
  );
}
