#!/usr/bin/env node
/**
 * Salesforce MCP Server - HTTP/SSE version for Railway deployment
 */

import express from "express";
import jsforce from "jsforce";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// ── Salesforce connection ─────────────────────────────────────────────────────
const conn = new jsforce.Connection({
  instanceUrl: process.env.SF_INSTANCE_URL,
  accessToken: process.env.SF_ACCESS_TOKEN,
  refreshToken: process.env.SF_REFRESH_TOKEN,
  oauth2: {
    clientId: process.env.SF_CONSUMER_KEY,
    clientSecret: process.env.SF_CONSUMER_SECRET,
  },
});

// ── Tool definitions ──────────────────────────────────────────────────────────
const tools = [
  {
    name: "sf_query",
    description: "Run a SOQL query against Salesforce to fetch any records.",
    inputSchema: {
      type: "object",
      properties: {
        soql: { type: "string", description: "A valid SOQL query, e.g. SELECT Id, Name FROM Account LIMIT 10" }
      },
      required: ["soql"]
    }
  },
  {
    name: "sf_get_record",
    description: "Fetch a single Salesforce record by Id.",
    inputSchema: {
      type: "object",
      properties: {
        objectType: { type: "string", description: "Salesforce object API name e.g. Account" },
        recordId: { type: "string", description: "The Salesforce record Id" }
      },
      required: ["objectType", "recordId"]
    }
  },
  {
    name: "sf_create_record",
    description: "Create a new Salesforce record.",
    inputSchema: {
      type: "object",
      properties: {
        objectType: { type: "string" },
        fields: { type: "object" }
      },
      required: ["objectType", "fields"]
    }
  },
  {
    name: "sf_update_record",
    description: "Update fields on an existing Salesforce record.",
    inputSchema: {
      type: "object",
      properties: {
        objectType: { type: "string" },
        recordId: { type: "string" },
        fields: { type: "object" }
      },
      required: ["objectType", "recordId", "fields"]
    }
  },
  {
    name: "sf_describe_object",
    description: "Get the schema for a Salesforce object including all field names and types.",
    inputSchema: {
      type: "object",
      properties: {
        objectType: { type: "string", description: "e.g. Agreement__c" }
      },
      required: ["objectType"]
    }
  },
  {
    name: "sf_list_objects",
    description: "List all Salesforce objects in this org including custom Flow Haven objects.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "sf_get_reports",
    description: "List all Salesforce reports.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "sf_run_report",
    description: "Run a Salesforce report by Id.",
    inputSchema: {
      type: "object",
      properties: {
        reportId: { type: "string" }
      },
      required: ["reportId"]
    }
  }
];

// ── Execute tool ──────────────────────────────────────────────────────────────
async function executeTool(name, args) {
  switch (name) {
    case "sf_query": {
      const res = await conn.query(args.soql);
      return { totalSize: res.totalSize, records: res.records };
    }
    case "sf_get_record":
      return await conn.sobject(args.objectType).retrieve(args.recordId);
    case "sf_create_record":
      return await conn.sobject(args.objectType).create(args.fields);
    case "sf_update_record":
      return await conn.sobject(args.objectType).update({ Id: args.recordId, ...args.fields });
    case "sf_describe_object": {
      const meta = await conn.sobject(args.objectType).describe();
      return {
        label: meta.label,
        fields: meta.fields.map(f => ({ name: f.name, label: f.label, type: f.type, required: !f.nillable }))
      };
    }
    case "sf_list_objects": {
      const meta = await conn.describeGlobal();
      return meta.sobjects.map(o => ({ name: o.name, label: o.label, custom: o.custom }));
    }
    case "sf_get_reports": {
      const res = await conn.query("SELECT Id, Name, FolderName, LastRunDate FROM Report ORDER BY LastRunDate DESC NULLS LAST LIMIT 100");
      return res.records;
    }
    case "sf_run_report":
      return await conn.request(`/services/data/v59.0/analytics/reports/${args.reportId}`);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP over HTTP endpoints ───────────────────────────────────────────────────

// SSE endpoint for Claude to connect
app.get("/sse", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Send server info
  res.write(`data: ${JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: { protocolVersion: "2024-11-05", serverInfo: { name: "salesforce-flowhaven", version: "1.0.0" }, capabilities: { tools: {} } }
  })}\n\n`);

  req.on("close", () => res.end());
});

// Main MCP message handler
app.post("/messages", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { jsonrpc, id, method, params } = req.body;

  try {
    let result;

    if (method === "initialize") {
      result = {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "salesforce-flowhaven", version: "1.0.0" },
        capabilities: { tools: {} }
      };
    } else if (method === "tools/list") {
      result = { tools };
    } else if (method === "tools/call") {
      const output = await executeTool(params.name, params.arguments || {});
      result = {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }]
      };
    } else {
      result = {};
    }

    res.json({ jsonrpc, id, result });
  } catch (err) {
    res.json({
      jsonrpc, id,
      error: { code: -32000, message: err.message }
    });
  }
});

app.options("*", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("Salesforce MCP Server for Flow Haven is running!"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Salesforce MCP Server running on port ${PORT}`));
