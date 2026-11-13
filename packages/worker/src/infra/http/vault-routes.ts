import { idSchema, operationSchema, pathSchema } from "@cf-sync/protocol";
import { Hono } from "hono";
import * as v from "valibot";

import type { Vault } from "../durable-objects/vault";
import type { Env } from "../env";
import { jsonStream } from "../rpc-json";
import { unwrapRpcResult } from "../rpc-result";

const exclusionsSchema = v.object({
  exclusions: v.pipe(v.array(pathSchema), v.maxLength(1000)),
});

const digestSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));

const searchSchema = v.object({
  q: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  limit: v.optional(
    v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(1), v.maxValue(50)),
    "10",
  ),
});

type VaultContext = {
  Bindings: Env;
  Variables: {
    vaultId: string;
    deviceId: string;
    vault: DurableObjectStub<Vault>;
  };
};

export const vaultApiRoutes = new Hono<VaultContext>();

vaultApiRoutes.use("*", async (c, next) => {
  const vaultId = v.parse(idSchema, c.req.param("vaultId"));
  const deviceId = v.parse(idSchema, c.req.header("X-Device-Id"));
  const account = c.env.ACCOUNT.getByName("owner");
  const [device, vault] = await Promise.all([account.device(deviceId), account.vault(vaultId)]);
  unwrapRpcResult(device);
  unwrapRpcResult(vault);

  c.set("vaultId", vaultId);
  c.set("deviceId", deviceId);
  c.set("vault", c.env.VAULTS.getByName(vaultId));
  await next();
});

vaultApiRoutes.get("/snapshot", async (c) => {
  const vault = c.get("vault");
  const result = await vault.snapshot(c.get("vaultId"), c.get("deviceId"));

  return new Response(unwrapRpcResult(result), {
    headers: { "Content-Type": "application/json" },
  });
});

vaultApiRoutes.post("/operations", async (c) => {
  const operation = v.parse(operationSchema, await c.req.json());
  const vault = c.get("vault");
  const result = await vault.applyOperation(
    c.get("vaultId"),
    c.get("deviceId"),
    jsonStream(operation),
  );

  return c.json(unwrapRpcResult(result));
});

vaultApiRoutes.get("/files/:id", async (c) => {
  const id = v.parse(idSchema, c.req.param("id"));
  const vault = c.get("vault");
  const result = await vault.document(c.get("vaultId"), c.get("deviceId"), id);

  return new Response(unwrapRpcResult(result), {
    headers: { "Content-Type": "application/json" },
  });
});

vaultApiRoutes.put("/exclusions", async (c) => {
  const { exclusions } = v.parse(exclusionsSchema, await c.req.json());
  const vault = c.get("vault");
  const result = await vault.setExclusions(c.get("vaultId"), c.get("deviceId"), exclusions);

  return new Response(unwrapRpcResult(result), {
    headers: { "Content-Type": "application/json" },
  });
});

vaultApiRoutes.post("/tickets", async (c) => {
  const vaultId = c.get("vaultId");
  const vault = c.get("vault");
  const result = await vault.issueTicket(vaultId, c.get("deviceId"));
  const ticket = unwrapRpcResult(result);
  const url = new URL("/ws", c.req.url);

  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else {
    url.protocol = "ws:";
  }

  url.searchParams.set("vault", vaultId);
  url.searchParams.set("ticket", ticket.ticket);
  c.header("Cache-Control", "no-store");

  return c.json({ url: url.href, expiresAt: ticket.expiresAt });
});

vaultApiRoutes.get("/blobs/:id", async (c) => {
  const id = v.parse(idSchema, c.req.param("id"));
  const vault = c.get("vault");
  const result = await vault.downloadBlob(c.get("vaultId"), c.get("deviceId"), id);
  const body = unwrapRpcResult(result);

  return new Response(body, { headers: { "Content-Type": "application/octet-stream" } });
});

vaultApiRoutes.get("/search", async (c) => {
  const { q, limit } = v.parse(searchSchema, c.req.query());
  const prefix = `vaults/${c.get("vaultId")}/files/`;
  const result = await c.env.SEARCH.search({
    query: q,
    ai_search_options: {
      retrieval: {
        max_num_results: limit,
        // Range on the folder attribute selects this vault's subtree; "0" sorts right after "/".
        filters: { folder: { $gte: prefix, $lt: `${prefix.slice(0, -1)}0` } },
      },
    },
  });
  const results = result.chunks
    .filter((chunk) => chunk.item.key.startsWith(prefix))
    .map((chunk) => ({
      path: chunk.item.key.slice(prefix.length),
      score: chunk.score,
      text: chunk.text,
    }));

  c.header("Cache-Control", "no-store");
  return c.json({ query: result.search_query, results });
});

vaultApiRoutes.put("/blobs/:id", async (c) => {
  const key = v.parse(idSchema, c.req.param("id"));
  const digest = v.parse(digestSchema, c.req.header("X-Content-Digest"));
  const size = c.req.raw.headers.get("X-Content-Size");
  const vault = c.get("vault");
  const result = await vault.uploadBlob(
    c.get("vaultId"),
    c.get("deviceId"),
    key,
    digest,
    c.req.raw.body,
    size,
  );

  return c.json(unwrapRpcResult(result));
});
