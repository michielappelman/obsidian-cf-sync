import { digestSchema, idSchema, pathSchema } from "@cf-sync/protocol";
import { Hono } from "hono";
import * as v from "valibot";

import type { Vault } from "../durable-objects/vault";
import { ownerAccount } from "../env";
import type { Env } from "../env";
import { unwrapRpcResult } from "../rpc-result";
import type { RpcResult } from "../rpc-result";

const exclusionsSchema = v.object({
	exclusions: v.pipe(v.array(pathSchema), v.maxLength(1000)),
});

const webhookSchema = v.object({
	url: v.pipe(v.string(), v.maxLength(2000), v.url(), v.startsWith("https://")),
	// Sent as a bearer token, so only characters a header carries unchanged.
	secret: v.pipe(v.string(), v.regex(/^[\w-]{32,200}$/u)),
});

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

function jsonStreamResponse(result: RpcResult<ReadableStream<Uint8Array>>): Response {
	return new Response(unwrapRpcResult(result), { headers: { "Content-Type": "application/json" } });
}

export const vaultApiRoutes = new Hono<VaultContext>();

vaultApiRoutes.use("*", async (c, next) => {
	const vaultId = v.parse(idSchema, c.req.param("vaultId"));
	const deviceId = v.parse(idSchema, c.req.header("X-Device-Id"));
	const account = ownerAccount(c.env);
	unwrapRpcResult(await account.authorizeVaultAccess(deviceId, vaultId));

	c.set("vaultId", vaultId);
	c.set("deviceId", deviceId);
	c.set("vault", c.env.VAULTS.getByName(vaultId));
	await next();
});

vaultApiRoutes.get("/snapshot", async (c) => {
	const vault = c.get("vault");
	const result = await vault.snapshot();

	return jsonStreamResponse(result);
});

vaultApiRoutes.post("/operations", async (c) => {
	const vault = c.get("vault");
	const result = await vault.applyOperation(c.get("deviceId"), c.req.raw.body);

	return c.json(unwrapRpcResult(result));
});

vaultApiRoutes.get("/files/:id", async (c) => {
	const id = v.parse(idSchema, c.req.param("id"));
	const vault = c.get("vault");
	const result = await vault.document(id);

	return jsonStreamResponse(result);
});

vaultApiRoutes.put("/exclusions", async (c) => {
	const { exclusions } = v.parse(exclusionsSchema, await c.req.json());
	const vault = c.get("vault");
	const result = await vault.setExclusions(exclusions);

	return jsonStreamResponse(result);
});

vaultApiRoutes.put("/webhook", async (c) => {
	const webhook = v.parse(webhookSchema, await c.req.json());
	const vault = c.get("vault");
	unwrapRpcResult(await vault.setWebhook(c.get("deviceId"), webhook));

	return c.body(null, 204);
});

vaultApiRoutes.delete("/webhook", async (c) => {
	const vault = c.get("vault");
	unwrapRpcResult(await vault.removeWebhook(c.get("deviceId")));

	return c.body(null, 204);
});

vaultApiRoutes.post("/tickets", async (c) => {
	const vaultId = c.get("vaultId");
	const deviceId = c.get("deviceId");
	const vault = c.get("vault");
	const result = await vault.issueTicket(deviceId);
	const ticket = unwrapRpcResult(result);

	// A deletion that finished between authorization and issuance could not discard this ticket.
	const account = ownerAccount(c.env);
	unwrapRpcResult(await account.authorizeVaultAccess(deviceId, vaultId));

	const url = new URL("/ws", c.req.url);

	if (url.protocol === "https:") {
		url.protocol = "wss:";
	} else {
		url.protocol = "ws:";
	}

	url.searchParams.set("vault", vaultId);
	url.searchParams.set("ticket", ticket.ticket);
	c.header("Cache-Control", "no-store");

	// Released plugins up to 0.3.1 reject a ticket response without expiresAt.
	return c.json({ url: url.href, expiresAt: ticket.expiresAt });
});

vaultApiRoutes.get("/blobs/:id", async (c) => {
	const id = v.parse(idSchema, c.req.param("id"));
	const vault = c.get("vault");
	const result = await vault.downloadBlob(id);
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
	const result = await vault.uploadBlob(key, digest, c.req.raw.body, size);

	return c.json(unwrapRpcResult(result));
});
