import { hydrantSurveyColors } from '@/helper/hydrantSurveyAge';

function widenRing(original: ImageData): ImageData {
	const { width, height, data } = original;
	const widened = new ImageData(width, height);
	const center = (width - 1) / 2;
	const innerRadius = (width * 52) / 128;
	// MapLibre displays the 128 px sprites at 25%, so 4 sprite pixels add 1 px.
	const widerInnerRadius = innerRadius - (width * 4) / 128;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const radius = Math.hypot(x - center, y - center);
			if (radius === 0 || radius >= center) {
				const offset = (y * width + x) * 4;
				widened.data.set(data.subarray(offset, offset + 4), offset);
				continue;
			}
			const sourceRadius =
				radius <= widerInnerRadius
					? (radius * innerRadius) / widerInnerRadius
					: innerRadius +
						((radius - widerInnerRadius) * (center - innerRadius)) / (center - widerInnerRadius);
			const scale = sourceRadius / radius;
			const sourceX = Math.round(center + (x - center) * scale);
			const sourceY = Math.round(center + (y - center) * scale);
			const offset = (sourceY * width + sourceX) * 4;
			widened.data.set(data.subarray(offset, offset + 4), (y * width + x) * 4);
		}
	}
	return widened;
}

export function hydrantSurveyImages(image: HTMLImageElement | ImageBitmap) {
	const canvas = document.createElement('canvas');
	canvas.width = image.width;
	canvas.height = image.height;
	const context = canvas.getContext('2d');
	if (!context) throw new Error('Could not create a canvas for hydrant icons');

	context.drawImage(image, 0, 0);
	const original = widenRing(context.getImageData(0, 0, canvas.width, canvas.height));
	return Object.entries(hydrantSurveyColors).map(([age, color]) => {
		const rgb = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
		const variant = new ImageData(
			new Uint8ClampedArray(original.data),
			canvas.width,
			canvas.height
		);
		for (let index = 0; index < original.data.length; index += 4) {
			const [red, green, blue] = original.data.subarray(index, index + 3);
			const ring = (red - Math.max(green, blue)) / 255;
			if (ring <= 0) continue;
			// Retain the neutral contribution of antialiased pixels and preserve alpha.
			variant.data[index] = red - 255 * ring + rgb[0] * ring;
			variant.data[index + 1] = green + rgb[1] * ring;
			variant.data[index + 2] = blue + rgb[2] * ring;
		}
		return { age, image: variant };
	});
}
