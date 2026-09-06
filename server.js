import express from "express";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";

const PORT = Number(process.env.PORT || 3000);

const ETLAALA_DOMAIN = process.env.HOSTINGER_DOMAIN || "etlaala.net";
const ETLAALA_USERNAME =
  process.env.HOSTINGER_USERNAME || "u926325448";

function buildMcpServer() {
  const server = new McpServer({
    name: "etlaala-hostinger-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "ping",
    {
      title: "Ping Etlaala MCP",
      description: "Check that the dedicated Etlaala MCP server is running.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({
      content: [
        {
          type: "text",
          text: "Etlaala MCP is online.",
        },
      ],
      structuredContent: {
        ok: true,
        service: "etlaala-hostinger-mcp",
      },
    })
  );

  server.registerTool(
    "etlaala_target",
    {
      title: "Etlaala Hostinger Target",
      description:
        "Return the Hostinger account and domain this dedicated MCP is locked to.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              domain: ETLAALA_DOMAIN,
              username: ETLAALA_USERNAME,
              hostingerApiTokenConfigured: Boolean(
                process.env.HOSTINGER_API_TOKEN
              ),
            },
            null,
            2
          ),
        },
      ],
      structuredContent: {
        domain: ETLAALA_DOMAIN,
        username: ETLAALA_USERNAME,
        hostingerApiTokenConfigured: Boolean(
          process.env.HOSTINGER_API_TOKEN
        ),
      },
    })
  );

  return server;
}

const app = express();
app.disable("x-powered-by");

app.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "etlaala-hostinger-mcp",
    mcp: "/mcp",
    health: "/health",
  });
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "etlaala-hostinger-mcp",
    domain: ETLAALA_DOMAIN,
    username: ETLAALA_USERNAME,
    hostingerApiTokenConfigured: Boolean(process.env.HOSTINGER_API_TOKEN),
  });
});

const mcpHandler = createMcpHandler(buildMcpServer);

app.all(
  "/mcp",
  toNodeHandler(mcpHandler, {
    onerror(error) {
      console.error("MCP error:", error);
    },
  })
);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Etlaala Hostinger MCP listening on 0.0.0.0:${PORT} (target ${ETLAALA_DOMAIN} / ${ETLAALA_USERNAME})`
  );
});
