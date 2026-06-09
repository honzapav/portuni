// Rendered markdown preview (read-only). GFM enabled for tables, task lists,
// strikethrough and autolinks. Styling lives in the `.md-preview` block in
// index.css so it tracks the design tokens / theme.
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function MarkdownPreview({ value }: { value: string }) {
  return (
    <div className="md-preview px-5 py-4">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // External links open in a new tab; relative ones are inert here.
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}
