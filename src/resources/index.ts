import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface ResourceDef {
  name: string;
  uri: string;
  file: string;
  title: string;
  description: string;
}

const RESOURCES: readonly ResourceDef[] = [
  {
    name: "architecture",
    uri: "portuni://architecture",
    file: "architecture.md",
    title: "Portuni architecture",
    description:
      "POPP entities, edge relations, organization invariant, principles-as-culture, events.",
  },
  {
    name: "sync-model",
    uri: "portuni://sync-model",
    file: "sync-model.md",
    title: "Portuni file sync model",
    description:
      "Local mirrors, sync_key paths, status workflow, confirm-first patterns, data-safety defaults, session discipline.",
  },
  {
    name: "scope-rules",
    uri: "portuni://scope-rules",
    file: "scope-rules.md",
    title: "Portuni read scope",
    description:
      "Session scope set, refusal contract, expand_scope semantics, scope modes, hard-floor rules.",
  },
  {
    name: "enums",
    uri: "portuni://enums",
    file: "enums.md",
    title: "Portuni enums",
    description:
      "Closed sets: node types, edge relations, statuses, lifecycle states, visibility, event types/statuses, file statuses.",
  },
];

export function registerResources(server: McpServer): void {
  for (const r of RESOURCES) {
    server.registerResource(
      r.name,
      r.uri,
      {
        title: r.title,
        description: r.description,
        mimeType: "text/markdown",
      },
      async (uri) => {
        // Resolve relative to this module so it works in both dev (tsx
        // running src/) and prod (node running dist/). From src/resources/
        // or dist/resources/, ../../mcp-resources is the repo-root
        // mcp-resources/ directory (kept outside docs/, which is
        // gitignored, so the resources ship with the repo).
        const fileUrl = new URL(
          `../../mcp-resources/${r.file}`,
          import.meta.url,
        );
        const text = await readFile(fileUrl, "utf8");
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: "text/markdown",
              text,
            },
          ],
        };
      },
    );
  }
}
