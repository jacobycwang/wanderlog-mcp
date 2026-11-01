import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { buildServer } from "../../src/server.ts";

// ChatGPT's Apps SDK rejects the whole connector ("mcp_validation") when any
// tool schema uses draft-07 tuple form (`items: [...]`), e.g. from z.tuple().
function findTupleItems(schema: unknown, path: string, hits: string[]): void {
  if (Array.isArray(schema)) {
    schema.forEach((s, i) => findTupleItems(s, `${path}[${i}]`, hits));
    return;
  }
  if (schema === null || typeof schema !== "object") return;
  for (const [key, value] of Object.entries(schema)) {
    if (key === "items" && Array.isArray(value)) hits.push(`${path}.items`);
    findTupleItems(value, `${path}.${key}`, hits);
  }
}

describe("tool input schemas", () => {
  let client: Client;
  let server: ReturnType<typeof buildServer>;

  beforeEach(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = buildServer({} as AppContext);
    client = new Client({ name: "schema-portability-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("never use tuple-form items, which ChatGPT rejects", async () => {
    const { tools } = await client.listTools();
    const hits: string[] = [];
    for (const tool of tools) findTupleItems(tool.inputSchema, tool.name, hits);

    expect(tools.length).toBeGreaterThan(20);
    expect(hits).toEqual([]);
  });
});
