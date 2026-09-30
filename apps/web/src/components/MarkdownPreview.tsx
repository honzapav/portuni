// Rendered markdown preview (read-only). GFM enabled for tables, task lists,
// strikethrough and autolinks. Styling lives in the `.md-preview` block in
// index.css so it tracks the design tokens / theme.
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { renderMarkdownLink } from "../lib/markdown-link";

export default function MarkdownPreview({ value }: { value: string }) {
  return (
    <div className="md-preview px-5 py-4">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => renderMarkdownLink(href, children),
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}
