import { DefaultWebViewOptions, InAppBrowser } from '@capacitor/inappbrowser';

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

			const finish = (result: { code?: string; error?: string }) => {
				settleOnce(() => {
					void (async () => {
						try {
							await InAppBrowser.close();
						} catch {
							/* close may fail if already closed */
						} finally {
							await this.cleanup();
						}

						if (result.error) return reject(new Error(result.error));
						if (!result.code) return reject(new Error('OAuth failed: missing authorization code'));
						resolve(result.code);
					})();
				});
			};

			// Fires after a navigation completes; use it like "url change"
			const navListener = await InAppBrowser.addListener(
				'browserPageNavigationCompleted',
				(event: any) => {
					if (settled) return;

					const urlString: string | undefined = event?.url;
					if (!urlString) return;
					if (!urlString.startsWith(redirectUri)) return;

					const url = new URL(urlString);
					const code = url.searchParams.get('code') ?? undefined;
					const error = url.searchParams.get('error') ?? undefined;

					finish({ code, error });
				}
			);

			const closedListener = await InAppBrowser.addListener('browserClosed', () => {
				if (settled) return;
				finish({ error: 'Authentication cancelled — browser was closed' });
			});

			this.listeners.push(navListener);
			this.listeners.push(closedListener);

			// Open OAuth provider inside the app web view
			InAppBrowser.openInWebView({
				url: authUrl,
				options: DefaultWebViewOptions
			});
		});
	}

	async cleanup(): Promise<void> {
		const listeners = this.listeners;
		this.listeners = [];
		await Promise.allSettled(listeners.map((l) => l.remove()));
	}
}
