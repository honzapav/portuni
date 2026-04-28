import type { NativeFormat } from "./types.js";

export interface NativeFormatDetection {
  is_native_format: boolean;
  native_format?: NativeFormat;
}

const MIME_TO_NATIVE: Record<string, NativeFormat> = {
  "application/vnd.google-apps.document": "gdoc",
  "application/vnd.google-apps.spreadsheet": "gsheet",
  "application/vnd.google-apps.presentation": "gslide",
};

export function detectNativeFormat(mimeType: string | null | undefined): NativeFormatDetection {
  if (!mimeType) return { is_native_format: false };
  const native = MIME_TO_NATIVE[mimeType];
  if (native) return { is_native_format: true, native_format: native };
  return { is_native_format: false };
}

export const EXPORT_MIME: Record<"pdf" | "markdown" | "docx", string> = {
  pdf: "application/pdf",
  markdown: "text/markdown",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
