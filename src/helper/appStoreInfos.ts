/** Project repository; the native builds link here instead of DONATION_URL. */
export const GITHUB_URL = 'https://github.com/steinerjakob/FireYak';

export const APP_STORE_URLS = {
	ios: 'https://apps.apple.com/app/id6759717059',
	android: 'https://play.google.com/store/apps/details?id=at.jst.fireyak'
};

/**
 * External donation links (Ko-fi) are only shown in the web/PWA build.
 * Google Play's payments policy forbids linking to external donation
 * services from inside the app unless the recipient is a verified tax-exempt
 * organisation (Apple's guideline 3.1.1 / 3.2.2 is similar), so the native
 * builds must not show them.
 */
export const DONATION_URL = 'https://ko-fi.com/jakobsteiner';
