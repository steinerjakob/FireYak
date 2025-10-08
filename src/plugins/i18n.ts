import { createI18n } from 'vue-i18n';
import en from '@/locales/en.json';
import de from '@/locales/de.json';

// Detect browser language or use default
const getBrowserLocale = (): string => {
	const navigatorLocale = navigator.language.split('-')[0];
	return ['en', 'de'].includes(navigatorLocale) ? navigatorLocale : 'en';
};

const i18n = createI18n({
	legacy: false, // Use Composition API mode
	locale: getBrowserLocale(),
	fallbackLocale: 'en',
	messages: {
		en,
		de
	}
});

export default i18n;
