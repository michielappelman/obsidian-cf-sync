import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { ApplicationError } from "../src/domain/errors";
import { authenticate } from "../src/infra/access-auth";
import type { Env } from "../src/infra/env";
import { apiRoutes } from "../src/infra/http/api-routes";

vi.mock("../src/infra/access-auth", () => ({ authenticate: vi.fn() }));

function setup() {
  vi.mocked(authenticate).mockReset();
  vi.mocked(authenticate).mockResolvedValue(undefined);

  const account = {
    device: vi.fn(async () => ({ ok: true, value: { id: "owner" } })),
    vault: vi.fn(async () => ({ ok: true, value: { id: "vault" } })),
    devices: vi.fn(async () => ({ ok: true, value: [] })),
  };
  const vault = {
    snapshot: vi.fn(async () => ({ ok: true, value: Response.json({ revision: 1 }).body! })),
    issueTicket: vi.fn(async () => ({ ok: true, value: { ticket: "secret", expiresAt: 123 } })),
  };
  const search = { search: vi.fn() };
  const env = {
    ACCOUNT: { getByName: () => account },
    VAULTS: { getByName: () => vault },
    SEARCH: search,
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>().route("/api", apiRoutes);
  const vaultId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const call = (path: string, method = "GET") =>
    app.request(
      `https://sync.test/api${path}`,
      { method, headers: { "X-Device-Id": deviceId } },
      env,
    );

  return { account, vault, search, call, vaultId, deviceId };
}

describe("Public API routes", () => {
  it("authenticates and verifies device and vault before calling RPC", async () => {
    const s = setup();

    expect((await s.call(`/vaults/${s.vaultId}/snapshot`)).status).toBe(200);
    expect(authenticate).toHaveBeenCalledOnce();
    expect(s.account.device).toHaveBeenCalledExactlyOnceWith(s.deviceId);
    expect(s.account.vault).toHaveBeenCalledExactlyOnceWith(s.vaultId);
    expect(s.vault.snapshot).toHaveBeenCalledExactlyOnceWith(s.vaultId, s.deviceId);
  });

  it.each([
    ["/snapshot", "POST"],
    ["/snapshot/extra", "GET"],
    ["/revoke", "POST"],
    ["/ws", "GET"],
  ])("rejects unsupported vault route %s with %s", async (path, method) => {
    const s = setup();

    expect((await s.call(`/vaults/${s.vaultId}${path}`, method)).status).toBe(404);
    expect(s.vault.snapshot).not.toHaveBeenCalled();
    expect(s.vault.issueTicket).not.toHaveBeenCalled();
  });

  it("fails before RPC when authentication rejects a request", async () => {
    const s = setup();
    vi.mocked(authenticate).mockRejectedValue(new ApplicationError("unauthenticated", "Denied"));

    expect((await s.call("/devices")).status).toBe(401);
    expect(s.account.devices).not.toHaveBeenCalled();
  });

  it("converts a vault ticket to a no-store public websocket URL", async () => {
    const s = setup();
    const response = await s.call(`/vaults/${s.vaultId}/tickets`, "POST");

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      url: `wss://sync.test/ws?vault=${s.vaultId}&ticket=secret`,
      expiresAt: 123,
    });
  });

  it("scopes search to the vault and drops chunks from other vaults", async () => {
    const s = setup();
    const prefix = `vaults/${s.vaultId}/files/`;
    s.search.search.mockResolvedValue({
      search_query: "garden",
      chunks: [
        { score: 0.9, text: "mine", item: { key: `${prefix}notes/a.md` } },
        { score: 0.8, text: "other", item: { key: `vaults/${crypto.randomUUID()}/files/b.md` } },
      ],
    });

    const response = await s.call(`/vaults/${s.vaultId}/search?q=%20garden%20&limit=5`);

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      query: "garden",
      results: [{ path: "notes/a.md", score: 0.9, text: "mine" }],
    });
    expect(s.search.search).toHaveBeenCalledExactlyOnceWith({
      query: "garden",
      ai_search_options: {
        retrieval: {
          max_num_results: 5,
          filters: { folder: { $gte: prefix, $lt: `vaults/${s.vaultId}/files0` } },
        },
      },
    });
  });

  it.each(["", "?q=", "?q=%20", "?q=x&limit=0", "?q=x&limit=51", "?q=x&limit=1.5"])(
    "rejects invalid search query %s before searching",
    async (query) => {
      const s = setup();

      expect((await s.call(`/vaults/${s.vaultId}/search${query}`)).status).toBe(400);
      expect(s.search.search).not.toHaveBeenCalled();
    },
  );
});
