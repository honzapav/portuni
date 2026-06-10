// Rendered markdown preview (read-only). GFM enabled for tables, task lists,
// strikethrough and autolinks. Styling lives in the `.md-preview` block in
// index.css so it tracks the design tokens / theme.
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openExternal } from "../lib/backend-url";
import { safeHref } from "../lib/safe-url";

export default function MarkdownPreview({ value }: { value: string }) {
  return (
    <div className="md-preview px-5 py-4">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // A plain <a target="_blank"> is a silent no-op inside the Tauri
          // webview, so external links go through openExternal (native
          // open_external command; window.open fallback in the browser).
          // Unsafe/relative hrefs render as inert text-colored anchors.
          a: ({ href, children }) => {
            const safe = safeHref(href ?? null);
            if (!safe) return <span>{children}</span>;
            return (
              <a
                href={safe}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => {
                  e.preventDefault();
                  void openExternal(safe);
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}
