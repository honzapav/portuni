// Quick integration test: connect to Portuni MCP, create a node, read it back
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(new URL("http://localhost:3001/sse"));
const client = new Client({ name: "test-client", version: "1.0.0" });

await client.connect(transport);
console.log("Connected to Portuni MCP");

// List tools
const tools = await client.listTools();
console.log("Available tools:", tools.tools.map((t) => t.name));

// Create organization node "Workflow"
console.log("\n--- Creating node ---");
const createResult = await client.callTool({
  name: "portuni_create_node",
  arguments: {
    type: "organization",
    name: "Workflow",
    description: "Workflow.ooo - digital tools consultancy",
  },
});
console.log("Create result:", createResult.content);

// Parse the ID from the result
const created = JSON.parse((createResult.content as Array<{ text: string }>)[0].text);
console.log("Created node ID:", created.id);

// Get node back by name
console.log("\n--- Getting node by name ---");
const getResult = await client.callTool({
  name: "portuni_get_node",
  arguments: { name: "Workflow" },
});
console.log("Get result:", (getResult.content as Array<{ text: string }>)[0].text);

await client.close();
console.log("\nDone. Phase 0 validated.");
