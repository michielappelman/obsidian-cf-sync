import type { AlarmStorage } from "./vault-maintenance";

export interface Webhook {
	url: string;
	secret: string;
}

export interface WebhookNotification {
	vaultId: string;
	revision: number;
}

const PREFIX = "webhook:";
const TIMEOUT_MS = 10_000;

// A device's webhook is told that the vault changed, never what changed: the receiver reads the
// snapshot with its own credentials.
export class VaultWebhooks {
	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly send: typeof fetch = (input, init) => fetch(input, init),
	) {}

	async set(deviceId: string, webhook: Webhook): Promise<void> {
		await this.storage.put(`${PREFIX}${deviceId}`, webhook);
	}

	async remove(deviceId: string): Promise<void> {
		await this.storage.delete(`${PREFIX}${deviceId}`);
	}

	async registered(storage: AlarmStorage = this.storage): Promise<boolean> {
		const webhooks = await storage.list({ prefix: PREFIX, limit: 1 });

		return webhooks.size > 0;
	}

	async notify(notification: WebhookNotification): Promise<void> {
		const webhooks = await this.storage.list<Webhook>({ prefix: PREFIX });

		await Promise.all(
			[...webhooks].map(([key, webhook]) =>
				this.deliver(key.slice(PREFIX.length), webhook, notification),
			),
		);
	}

	// Never throws and never retries: the next change notifies again, and a receiver that polls
	// occasionally loses nothing.
	private async deliver(
		deviceId: string,
		webhook: Webhook,
		notification: WebhookNotification,
	): Promise<void> {
		let status: number;

		try {
			const response = await this.send(webhook.url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${webhook.secret}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(notification),
				redirect: "manual",
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			await response.body?.cancel();
			status = response.status;
		} catch {
			console.warn({ event: "webhook.unreachable", deviceId });
			return;
		}

		if (status === 404 || status === 410) {
			// The receiver no longer knows this webhook.
			await this.remove(deviceId);
			console.info({ event: "webhook.removed", deviceId, status });
			return;
		}

		if (status < 200 || status >= 300) {
			console.warn({ event: "webhook.rejected", deviceId, status });
		}
	}
}
