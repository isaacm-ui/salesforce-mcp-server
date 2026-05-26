#!/usr/bin/env node
/**
 * Salesforce MCP Server - Fixed SSE version for Claude.ai
 */

import express from "express";
import jsforce from "jsforce";
import dotenv from "dotenv";
import { randomUUID } from "crypto";

dotenv.config();

const app = express();
app.use(express.json());

// CORS for Claude.ai
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Salesforce connection
const conn = new jsforce.Connection({
  instanceUrl: process.env.SF_INSTANCE_URL,
  accessToken: process.env.SF_ACCESS_TOKEN,
  refreshToken: process.env.SF_REFRESH_TOKEN,
  oauth2: {
    clientId: process.env.SF_CONSUMER_KEY,
    clientSecret: process.env.SF_CONSUMER_SECRET,
  },
});

const tools = [
  {
    name: "sf_query",
    description: "Run a SOQL query against Salesforce to fetch any records including Flow Haven agreements, accounts, contacts, opportunities.",
    inputSchema: {
      type: "object",
      properties: {
        soql: { type: "string", description: "SOQL query e.g. SELECT Id, Name FROM Account LIMIT 10" }
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
        objectType: { type: "string" },
        recordId: { type: "string" }
      },
      required: ["objectType", "recordId"]
    }
  },
  {
    name: "sf_describe_object",
    description: "Get the schema for a Salesforce object - all fields, types, labels.",
    inputSchema: {
      type: "object",
      properties: {
        objectType: { type: "string", description: "e.g. Agreement__c, Account, Opportunity" }
      },
      required: ["objectType"]
    }
  },
  {
    name: "sf_list_objects",
    description: "List all Salesforce objects including custom Flow Haven objects.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "sf_get_reports",
    description: "List all Salesforce reports.",
    inputSchema: { type: "object", properties: {} }
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
    description: "Update an existing Salesforce record.",
    inputSchema: {
      type: "object",
      properties: {
        objectType: { type: "string" },
        recordId: { type: "string" },
        fields: { type: "object" }
      },
      required: ["objectType", "recordId", "fields"]
    }
  }
];

async function executeTool(name, args) {
  switch (name) {
    case "sf_query": {
      const res = await conn.query(args.soql);
      return { totalSize: res.totalSize, records: res.records };
    }
    case "sf_get_record":
      return await conn.sobject(args.objectType).retrieve(args.recordId);
    case "sf_describe_object": {
      const meta = await conn.sobject(args.objectType).describe();
      return {
        label: meta.label,
        fields: meta.fields.map(f => ({ name: f.name, label: f.label, type: f.type }))
      };
    }
    case "sf_list_objects": {
      const meta = await conn.describeGlobal();
      return meta.sobjects.map(o => ({ name: o.name, label: o.label, custom: o.custom }));
    }
    case "sf_get_reports": {
      const res = await conn.query("SELECT Id, Name, FolderName FROM Report LIMIT 100");
      return res.records;
    }
    case "sf_create_record":
      return await conn.sobject(args.objectType).create(args.fields);
    case "sf_update_record":
      return await conn.sobject(args.objectType).update({ Id: args.recordId, ...args.fields });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// SSE clients store
const clients = new Map();

// SSE endpoint - Claude connects here
app.get("/sse", (req, res) => {
  const sessionId = randomUUID();
  
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  clients.set(sessionId, res);

  // Send endpoint info
  res.write(`event: endpoint\ndata: ${JSON.stringify({ uri: `/messages?sessionId=${sessionId}` })}\n\n`);

  req.on("close", () => {
    clients.delete(sessionId);
  });
});

// Messages endpoint
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const client = clients.get(sessionId);
  
  const { jsonrpc, id, method, params } = req.body;
  res.json({ jsonrpc: "2.0", id, result: "accepted" });

  let result;
  try {
    if (method === "initialize") {
      result = {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "salesforce-flowhaven", version: "1.0.0" },
        capabilities: { tools: {} }
      };
    } else if (method === "notifications/initialized") {
      return;
    } else if (method === "tools/list") {
      result = { tools };
    } else if (method === "tools/call") {
      const output = await executeTool(params.name, params.arguments || {});
      result = { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    } else {
      result = {};
    }

    if (client) {
      client.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`);
    }
  } catch (err) {
    if (client) {
      client.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: err.message } })}\n\n`);
    }
  }
});

app.get("/", (req, res) => res.send("Salesforce MCP Server for Flow Haven - Running!"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
