// Seed real POPP organizational structure via Portuni MCP
// Idempotent: safe to run multiple times (findOrCreate + duplicate-safe connect)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(new URL("http://localhost:3001/sse"));
const client = new Client({ name: "seed-popp", version: "1.0.0" });
await client.connect(transport);
console.log("Connected to Portuni MCP\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function text(result: Awaited<ReturnType<typeof client.callTool>>): string {
  return (result.content as Array<{ text: string }>)[0].text;
}

async function findOrCreate(
  type: string,
  name: string,
  description: string,
): Promise<string> {
  // Try to find existing node by name
  const getResult = await client.callTool({
    name: "portuni_get_node",
    arguments: { name },
  });

  if (!getResult.isError) {
    const node = JSON.parse(text(getResult));
    console.log(`  [exists]  ${type}/${name} (${node.id})`);
    return node.id;
  }

  // Not found -- create it
  const createResult = await client.callTool({
    name: "portuni_create_node",
    arguments: { type, name, description },
  });
  const node = JSON.parse(text(createResult));
  console.log(`  [created] ${type}/${name} (${node.id})`);
  return node.id;
}

async function connect(
  sourceId: string,
  targetId: string,
  relation: string,
): Promise<void> {
  const result = await client.callTool({
    name: "portuni_connect",
    arguments: { source_id: sourceId, target_id: targetId, relation },
  });
  const edge = JSON.parse(text(result));
  if (edge.message === "Edge already exists") {
    console.log(`  [exists]  ${relation} (${edge.id})`);
  } else {
    console.log(`  [created] ${relation} (${edge.id})`);
  }
}

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------
console.log("=== Organizations ===");
const workflow = await findOrCreate(
  "organization",
  "Workflow",
  "Workflow.ooo - digital tools consultancy, Google Workspace partner",
);
const tempo = await findOrCreate(
  "organization",
  "Tempo",
  "Tempo - staffing, HR, and professional network",
);
const nautie = await findOrCreate(
  "organization",
  "Nautie",
  "Nautie - qualitative research platform",
);
const evoluce = await findOrCreate(
  "organization",
  "Evoluce",
  "Evoluce - holding company",
);

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------
console.log("\n=== Areas ===");
const gwsServices = await findOrCreate(
  "area",
  "Google Workspace Services",
  "Core service area: GWS implementations, migrations, management",
);
const aiAutomation = await findOrCreate(
  "area",
  "AI and Automation",
  "AI competency assessments, automation consulting",
);
const staffingServices = await findOrCreate(
  "area",
  "Staffing Services",
  "Professional staffing and recruitment",
);
const qualResearch = await findOrCreate(
  "area",
  "Qualitative Research",
  "User research, interviews, analysis",
);

// ---------------------------------------------------------------------------
// Methodologies
// ---------------------------------------------------------------------------
console.log("\n=== Methodologies ===");
const gwsImpl = await findOrCreate(
  "methodology",
  "GWS Implementation",
  "Standard methodology for Google Workspace migrations and implementations",
);
const aiAssessment = await findOrCreate(
  "methodology",
  "AI Competency Assessment",
  "ADAMAI methodology for assessing organizational AI readiness",
);

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------
console.log("\n=== Processes ===");
const licenseProcurement = await findOrCreate(
  "process",
  "License Procurement",
  "Standard process: quote via StreamOne Ion, purchase, assign licenses",
);
const clientOnboarding = await findOrCreate(
  "process",
  "Client Onboarding",
  "Shared onboarding process across Workflow and Tempo",
);
const recruitmentPipeline = await findOrCreate(
  "process",
  "Recruitment Pipeline",
  "Tempo's recruitment and candidate management process",
);
const researchDesign = await findOrCreate(
  "process",
  "Research Design",
  "Nautie's qualitative research design and execution process",
);

// ---------------------------------------------------------------------------
// Principles
// ---------------------------------------------------------------------------
console.log("\n=== Principles ===");
const startWithAssessment = await findOrCreate(
  "principle",
  "Start with Assessment",
  "Always assess current state before migration or change",
);
const documentDecisions = await findOrCreate(
  "principle",
  "Document Decisions",
  "Every significant decision gets logged with rationale",
);
const flatStructure = await findOrCreate(
  "principle",
  "Flat Structure",
  "Prefer flat organizational structures over deep hierarchies",
);

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
console.log("\n=== Projects ===");
const stanGws = await findOrCreate(
  "project",
  "STAN GWS",
  "Google Workspace implementation for STAN",
);
const adamai = await findOrCreate(
  "project",
  "ADAMAI",
  "AI competency assessment tool and methodology",
);

// ---------------------------------------------------------------------------
// Edges: Areas -> Orgs (belongs_to)
// ---------------------------------------------------------------------------
console.log("\n=== Edges: Areas -> Orgs ===");
await connect(gwsServices, workflow, "belongs_to");
await connect(aiAutomation, workflow, "belongs_to");
await connect(staffingServices, tempo, "belongs_to");
await connect(qualResearch, nautie, "belongs_to");

// ---------------------------------------------------------------------------
// Edges: Methodologies -> Orgs (belongs_to)
// ---------------------------------------------------------------------------
console.log("\n=== Edges: Methodologies -> Orgs ===");
await connect(gwsImpl, workflow, "belongs_to");
await connect(aiAssessment, workflow, "belongs_to");

// ---------------------------------------------------------------------------
// Edges: Processes -> Orgs (belongs_to)
// ---------------------------------------------------------------------------
console.log("\n=== Edges: Processes -> Orgs ===");
await connect(licenseProcurement, workflow, "belongs_to");
await connect(clientOnboarding, workflow, "belongs_to");
await connect(clientOnboarding, tempo, "belongs_to"); // shared!
await connect(recruitmentPipeline, tempo, "belongs_to");
await connect(researchDesign, nautie, "belongs_to");

// ---------------------------------------------------------------------------
// Edges: Projects -> Areas (belongs_to)
// ---------------------------------------------------------------------------
console.log("\n=== Edges: Projects -> Areas ===");
await connect(stanGws, gwsServices, "belongs_to");
await connect(adamai, aiAutomation, "belongs_to");

// ---------------------------------------------------------------------------
// Edges: Projects -> Methodologies (instance_of)
// ---------------------------------------------------------------------------
console.log("\n=== Edges: Projects -> Methodologies ===");
await connect(stanGws, gwsImpl, "instance_of");
await connect(adamai, aiAssessment, "instance_of");

// ---------------------------------------------------------------------------
// Edges: Projects -> Processes (applies)
// ---------------------------------------------------------------------------
console.log("\n=== Edges: Projects -> Processes ===");
await connect(stanGws, licenseProcurement, "applies");

// ---------------------------------------------------------------------------
// Edges: Projects -> Principles (guided_by)
// ---------------------------------------------------------------------------
console.log("\n=== Edges: Projects -> Principles ===");
await connect(stanGws, startWithAssessment, "guided_by");
await connect(adamai, documentDecisions, "guided_by");

// ---------------------------------------------------------------------------
// Edges: Principles -> Orgs (belongs_to)
// ---------------------------------------------------------------------------
console.log("\n=== Edges: Principles -> Orgs ===");
await connect(startWithAssessment, workflow, "belongs_to");
await connect(documentDecisions, workflow, "belongs_to");
await connect(flatStructure, evoluce, "belongs_to");

// ---------------------------------------------------------------------------
// Verification: traverse from STAN GWS at depth 2
// ---------------------------------------------------------------------------
console.log("\n=== Verification: STAN GWS context (depth 2) ===\n");

const contextResult = await client.callTool({
  name: "portuni_get_context",
  arguments: { node_id: stanGws, depth: 2 },
});
const context = JSON.parse(text(contextResult));

for (const node of context) {
  const indent = "  ".repeat(node.depth);
  const edgeSummary = node.edges
    .map(
      (e: { direction: string; relation: string; peer_type: string; peer_name: string }) =>
        `${e.direction === "outgoing" ? "->" : "<-"} ${e.relation} ${e.peer_type}/${e.peer_name}`,
    )
    .join(", ");
  console.log(`${indent}[depth ${node.depth}] ${node.type}/${node.name}`);
  if (edgeSummary) {
    console.log(`${indent}  edges: ${edgeSummary}`);
  }
}

console.log("\nDone. POPP structure seeded.");
await client.close();
