// Phase 1 end-to-end test: graph CRUD, traversal, local mirror, file store/pull
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const transport = new SSEClientTransport(new URL("http://localhost:3001/sse"));
const client = new Client({ name: "test-phase1", version: "1.0.0" });
await client.connect(transport);

function text(result: Awaited<ReturnType<typeof client.callTool>>): string {
  return (result.content as Array<{ text: string }>)[0].text;
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// 1. Create organizations
// ---------------------------------------------------------------------------
console.log("\n=== 1. Create organizations ===");

const workflowRes = JSON.parse(
  text(
    await client.callTool({
      name: "portuni_create_node",
      arguments: {
        type: "organization",
        name: "Workflow",
        description: "Workflow.ooo - digital tools consultancy",
      },
    }),
  ),
);
console.log("  Created:", workflowRes.name, workflowRes.id);
assert(!!workflowRes.id, "Workflow org created");

const tempoRes = JSON.parse(
  text(
    await client.callTool({
      name: "portuni_create_node",
      arguments: {
        type: "organization",
        name: "Tempo",
        description: "Tempo - professional network for modern work",
      },
    }),
  ),
);
console.log("  Created:", tempoRes.name, tempoRes.id);
assert(!!tempoRes.id, "Tempo org created");

// ---------------------------------------------------------------------------
// 2. Create POPP entities
// ---------------------------------------------------------------------------
console.log("\n=== 2. Create POPP entities ===");

const areaRes = JSON.parse(
  text(
    await client.callTool({
      name: "portuni_create_node",
      arguments: {
        type: "area",
        name: "Google Workspace Services",
        description: "Consulting and implementation services for Google Workspace",
      },
    }),
  ),
);
console.log("  Created area:", areaRes.name, areaRes.id);
assert(areaRes.type === "area", "Area node type correct");

const methodologyRes = JSON.parse(
  text(
    await client.callTool({
      name: "portuni_create_node",
      arguments: {
        type: "methodology",
        name: "GWS Implementation",
        description: "Standard methodology for Google Workspace implementations",
      },
    }),
  ),
);
console.log("  Created methodology:", methodologyRes.name, methodologyRes.id);
assert(methodologyRes.type === "methodology", "Methodology node type correct");

const processRes = JSON.parse(
  text(
    await client.callTool({
      name: "portuni_create_node",
      arguments: {
        type: "process",
        name: "License Procurement",
        description: "Process for procuring Google Workspace licenses",
      },
    }),
  ),
);
console.log("  Created process:", processRes.name, processRes.id);
assert(processRes.type === "process", "Process node type correct");

const principleRes = JSON.parse(
  text(
    await client.callTool({
      name: "portuni_create_node",
      arguments: {
        type: "principle",
        name: "Start with Assessment",
        description: "Always begin with a thorough assessment of the current state",
      },
    }),
  ),
);
console.log("  Created principle:", principleRes.name, principleRes.id);
assert(principleRes.type === "principle", "Principle node type correct");

const projectRes = JSON.parse(
  text(
    await client.callTool({
      name: "portuni_create_node",
      arguments: {
        type: "project",
        name: "STAN GWS",
        description: "Google Workspace implementation project for STAN",
      },
    }),
  ),
);
console.log("  Created project:", projectRes.name, projectRes.id);
assert(projectRes.type === "project", "Project node type correct");

// ---------------------------------------------------------------------------
// 3. Connect edges
// ---------------------------------------------------------------------------
console.log("\n=== 3. Connect edges ===");

const edges = [
  { source: areaRes.id, target: workflowRes.id, relation: "belongs_to", label: "area -> Workflow (belongs_to)" },
  { source: projectRes.id, target: areaRes.id, relation: "belongs_to", label: "project -> area (belongs_to)" },
  { source: projectRes.id, target: methodologyRes.id, relation: "instance_of", label: "project -> methodology (instance_of)" },
  { source: projectRes.id, target: processRes.id, relation: "applies", label: "project -> process (applies)" },
  { source: projectRes.id, target: principleRes.id, relation: "guided_by", label: "project -> principle (guided_by)" },
];

for (const edge of edges) {
  const edgeRes = JSON.parse(
    text(
      await client.callTool({
        name: "portuni_connect",
        arguments: {
          source_id: edge.source,
          target_id: edge.target,
          relation: edge.relation,
        },
      }),
    ),
  );
  console.log(`  Connected: ${edge.label} (${edgeRes.id})`);
  assert(!!edgeRes.id, edge.label);
}

// ---------------------------------------------------------------------------
// 4. Traverse from project (depth 2)
// ---------------------------------------------------------------------------
console.log("\n=== 4. Traverse graph from project (depth 2) ===");

const contextRes = JSON.parse(
  text(
    await client.callTool({
      name: "portuni_get_context",
      arguments: { node_id: projectRes.id, depth: 2 },
    }),
  ),
);

const contextNames = (contextRes as Array<{ name: string }>).map((n) => n.name);
console.log("  Reachable nodes:", contextNames);

const expectedNames = [
  "STAN GWS",
  "Google Workspace Services",
  "GWS Implementation",
  "License Procurement",
  "Start with Assessment",
  "Workflow",
];

for (const name of expectedNames) {
  assert(contextNames.includes(name), `Context includes "${name}"`);
}

// ---------------------------------------------------------------------------
// 5. Mirror project locally
// ---------------------------------------------------------------------------
console.log("\n=== 5. Mirror project locally ===");

const mirrorRes = JSON.parse(
  text(
    await client.callTool({
      name: "portuni_mirror",
      arguments: { node_id: projectRes.id, targets: ["local"] },
    }),
  ),
);
console.log("  Mirror path:", mirrorRes.local_path);
assert(!!mirrorRes.local_path, "Mirror path returned");
assert(
  Array.isArray(mirrorRes.subdirs) && mirrorRes.subdirs.length === 3,
  "Mirror has 3 subdirs",
);

// ---------------------------------------------------------------------------
// 6. Store a file
// ---------------------------------------------------------------------------
console.log("\n=== 6. Store a file ===");

const tmpDir = await mkdtemp(join(tmpdir(), "portuni-test-"));
const testFile = join(tmpDir, "proposal.md");
await writeFile(testFile, "# STAN GWS Proposal\n\nThis is a test proposal.");

const storeRes = JSON.parse(
  text(
    await client.callTool({
      name: "portuni_store",
      arguments: {
        node_id: projectRes.id,
        local_path: testFile,
        description: "Test proposal document",
        status: "output",
      },
    }),
  ),
);
console.log("  Stored file:", storeRes.filename, "->", storeRes.local_path);
assert(storeRes.filename === "proposal.md", "Filename is proposal.md");
assert(storeRes.status === "output", "File status is output");

// ---------------------------------------------------------------------------
// 7. Pull files
// ---------------------------------------------------------------------------
console.log("\n=== 7. Pull files for project ===");

const pullRes = JSON.parse(
  text(
    await client.callTool({
      name: "portuni_pull",
      arguments: { node_id: projectRes.id },
    }),
  ),
);
console.log("  Files found:", pullRes.files.length);
assert(pullRes.files.length >= 1, "At least 1 file returned by pull");
assert(
  pullRes.files.some((f: { filename: string }) => f.filename === "proposal.md"),
  "proposal.md listed in pull",
);

// ---------------------------------------------------------------------------
// 8. Get full node (STAN GWS)
// ---------------------------------------------------------------------------
console.log("\n=== 8. Get full node: STAN GWS ===");

const fullNode = JSON.parse(
  text(
    await client.callTool({
      name: "portuni_get_node",
      arguments: { name: "STAN GWS" },
    }),
  ),
);
console.log("  Node ID:", fullNode.id);
console.log("  Edges:", fullNode.edges.length);
console.log("  Files:", fullNode.files.length);
console.log("  Local mirror:", fullNode.local_mirror?.local_path ?? "none");

assert(Array.isArray(fullNode.edges) && fullNode.edges.length >= 4, "Node has >= 4 edges");
assert(Array.isArray(fullNode.files) && fullNode.files.length >= 1, "Node has >= 1 file");
assert(fullNode.local_mirror !== null, "Node has local_mirror");

// ---------------------------------------------------------------------------
// 9. List nodes by type
// ---------------------------------------------------------------------------
console.log("\n=== 9. List nodes by type: organization ===");

const orgs = JSON.parse(
  text(
    await client.callTool({
      name: "portuni_list_nodes",
      arguments: { type: "organization" },
    }),
  ),
);

const orgNames = (orgs as Array<{ name: string }>).map((n) => n.name);
console.log("  Organizations:", orgNames);
assert(orgNames.includes("Workflow"), "Workflow in org list");
assert(orgNames.includes("Tempo"), "Tempo in org list");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log("=".repeat(50));

// Cleanup
await rm(tmpDir, { recursive: true, force: true });
await client.close();

if (failed > 0) {
  console.log("\nPhase 1 test FAILED.");
  process.exit(1);
} else {
  console.log("\nPhase 1 test PASSED.");
}
