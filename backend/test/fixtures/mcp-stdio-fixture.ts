let buffer = "";

process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf-8");
  let newlineIndex = buffer.indexOf("\n");
  while (newlineIndex !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line) respond(JSON.parse(line) as Record<string, unknown>);
    newlineIndex = buffer.indexOf("\n");
  }
});

function respond(message: Record<string, unknown>): void {
  const id = message.id;
  if (typeof id !== "number") return;
  const params = isRecord(message.params) ? message.params : {};
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } } });
    return;
  }
  if (message.method === "tools/list") {
    const secondPage = params.cursor === "page-2";
    send({
      jsonrpc: "2.0",
      id,
      result: secondPage
        ? { tools: [{ name: "write_note", description: "Write a test note", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] }
        : { tools: [{ name: "read_note", description: "Read a test note", inputSchema: { type: "object", properties: {} } }], nextCursor: "page-2" },
    });
    return;
  }
  if (message.method === "tools/call") {
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `called ${String(params.name)}` }], isError: false } });
    return;
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
