// Streamdown's own labels (copy, download, full screen, the external-link
// dialog) from the `chat` catalog, for every Streamdown the chat renders
// (ai-elements/message.tsx, ai-elements/reasoning.tsx). One literal key per
// label, so a new Streamdown label fails the typecheck until it has one.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { StreamdownTranslations } from "streamdown";

export function useStreamdownTranslations(): StreamdownTranslations {
  // react-i18next hands out a new `t` when the language changes, so the
  // labels are rebuilt then and only then.
  const { t } = useTranslation("chat");
  return useMemo(
    () => ({
      close: t(($) => $.streamdown.close),
      copied: t(($) => $.streamdown.copied),
      copyCode: t(($) => $.streamdown.copy_code),
      copyLink: t(($) => $.streamdown.copy_link),
      copyTable: t(($) => $.streamdown.copy_table),
      copyTableAsCsv: t(($) => $.streamdown.copy_table_as_csv),
      copyTableAsMarkdown: t(($) => $.streamdown.copy_table_as_markdown),
      copyTableAsTsv: t(($) => $.streamdown.copy_table_as_tsv),
      downloadDiagram: t(($) => $.streamdown.download_diagram),
      downloadDiagramAsMmd: t(($) => $.streamdown.download_diagram_as_mmd),
      downloadDiagramAsPng: t(($) => $.streamdown.download_diagram_as_png),
      downloadDiagramAsSvg: t(($) => $.streamdown.download_diagram_as_svg),
      downloadFile: t(($) => $.streamdown.download_file),
      downloadImage: t(($) => $.streamdown.download_image),
      downloadTable: t(($) => $.streamdown.download_table),
      downloadTableAsCsv: t(($) => $.streamdown.download_table_as_csv),
      downloadTableAsMarkdown: t(($) => $.streamdown.download_table_as_markdown),
      exitFullscreen: t(($) => $.streamdown.exit_fullscreen),
      externalLinkWarning: t(($) => $.streamdown.external_link_warning),
      imageNotAvailable: t(($) => $.streamdown.image_not_available),
      mermaidFormatMmd: t(($) => $.streamdown.mermaid_format_mmd),
      mermaidFormatPng: t(($) => $.streamdown.mermaid_format_png),
      mermaidFormatSvg: t(($) => $.streamdown.mermaid_format_svg),
      openExternalLink: t(($) => $.streamdown.open_external_link),
      openLink: t(($) => $.streamdown.open_link),
      resetView: t(($) => $.streamdown.reset_view),
      tableFormatCsv: t(($) => $.streamdown.table_format_csv),
      tableFormatMarkdown: t(($) => $.streamdown.table_format_markdown),
      tableFormatTsv: t(($) => $.streamdown.table_format_tsv),
      viewFullscreen: t(($) => $.streamdown.view_fullscreen),
      zoomIn: t(($) => $.streamdown.zoom_in),
      zoomOut: t(($) => $.streamdown.zoom_out),
    }),
    [t],
  );
}
