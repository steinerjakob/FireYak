import { InAppBrowser } from '@capgo/inappbrowser';

export class OAuthService {
	private listeners: { remove: () => Promise<void> | void }[] = [];

	async authenticate(authUrl: string, redirectUri: string): Promise<string> {
		return new Promise<string>(async (resolve, reject) => {
			let settled = false;

			const settleOnce = (fn: () => void) => {
				if (settled) return;
				settled = true;
				fn();
			};

			const urlListener = await InAppBrowser.addListener('urlChangeEvent', async (event) => {
				if (!event?.url) return;
				if (!event.url.startsWith(redirectUri)) return;

				const url = new URL(event.url);
				const code = url.searchParams.get('code');
				const error = url.searchParams.get('error');

				// Close ASAP to avoid races with native deep-link handling.
				if (code) {
					await new Promise((r) => setTimeout(r, 50));
					await InAppBrowser.close();
					resolve(code);
				} else {
					const error = url.searchParams.get('error');
					reject(new Error(error || 'OAuth failed'));
				}
			});

			this.listeners.push(urlListener);

			// Open OAuth provider inside the app
			InAppBrowser.openWebView({
				url: authUrl,
				preventDeeplink: true
			});
		});
	}

	async cleanup(): Promise<void> {
		const listeners = this.listeners;
		this.listeners = [];
		await Promise.allSettled(listeners.map((l) => l.remove()));
	}
}
