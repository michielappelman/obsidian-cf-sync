import { bindings, defineConfig, exports } from "cf/config";

export default defineConfig({
	worker: {
		name: "obsidian-cf-sync",
		compatibilityDate: "2026-09-09",
		entrypoint: "src/index.ts",
		observability: {
			redactQueryString: true,
			logs: {
				enabled: true,
				headSamplingRate: 1,
				invocationLogs: true,
			},
		},
		domains: ["sync.appelman.family"],
		workersDev: false,
		previewUrls: false,
		exports: {
			AccountDO: exports.durableObject({ storage: "sqlite" }),
			VaultDO: exports.durableObject({ storage: "sqlite" }),
		},
		env: {
			ACCESS_TEAM_DOMAIN: bindings.secret(),
			ACCESS_AUD: bindings.secret(),
			BUCKET: bindings.r2({
				name: "obsidian-cf-sync",
			}),
			SEARCH: bindings.aiSearch({
				name: "obsidian-cf-sync",
			}),
			ACCOUNT: bindings.durableObject({
				worker: "obsidian-cf-sync",
				exportName: "AccountDO",
			}),
			VAULTS: bindings.durableObject({
				worker: "obsidian-cf-sync",
				exportName: "VaultDO",
			}),
		},
	},
});
