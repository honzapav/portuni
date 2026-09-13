// Rendered markdown preview (read-only). GFM enabled for tables, task lists,
// strikethrough and autolinks. Styling lives in the `.md-preview` block in
// index.css so it tracks the design tokens / theme.
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { externalLinkProps } from "../lib/external-link";
import { safeHref } from "../lib/safe-url";

export default function MarkdownPreview({ value }: { value: string }) {
  return (
    <div className="md-preview px-5 py-4">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // External links go through externalLinkProps: native anchor in
          // the browser, the `open_external` command in Tauri (see
          // lib/external-link.ts for why the anchor must not carry
          // target="_blank" there). Unsafe/relative hrefs render as inert
          // text-colored anchors.
          a: ({ href, children }) => {
            const safe = safeHref(href ?? null);
            if (!safe) return <span>{children}</span>;
            return <a {...externalLinkProps(safe)}>{children}</a>;
          },
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}
