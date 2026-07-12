/** Formats a byte count as a localized human-readable size, e.g. "12.4 MB". */
export const formatBytes = (bytes: number, locale: string): string => {
	let value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
	const units = ['B', 'KB', 'MB', 'GB'];
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
	return `${value.toLocaleString(locale || 'en', { maximumFractionDigits: digits })} ${units[unit]}`;
};

export const debounce = (mainFunction: any, delay: number) => {
	// Declare a variable called 'timer' to store the timer ID
	let timer: any;

	// Return an anonymous function that takes in any number of arguments
	return function (...args: any[]) {
		// Clear the previous timer to prevent the execution of 'mainFunction'
		clearTimeout(timer);

		// Set a new timer that will execute 'mainFunction' after the specified delay
		timer = setTimeout(() => {
			mainFunction(...args);
		}, delay);
	};
};
