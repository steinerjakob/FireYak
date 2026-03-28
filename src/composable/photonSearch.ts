import { ref } from 'vue';

export interface PhotonFeature {
	type: string;
	geometry: {
		type: string;
		coordinates: [number, number]; // [lng, lat]
	};
	properties: {
		osm_id: number;
		osm_type: string;
		name?: string;
		street?: string;
		housenumber?: string;
		postcode?: string;
		city?: string;
		state?: string;
		country?: string;
		osm_key?: string;
		osm_value?: string;
		type?: string;
		district?: string;
		locality?: string;
		county?: string;
	};
}

const query = ref<string>('');
const results = ref<PhotonFeature[]>([]);
const isLoading = ref<boolean>(false);
let abortController: AbortController | null = null;

async function searchPhoton(text: string, lang: string, lat?: number, lon?: number): Promise<void> {
	if (!text || text.length < 2) {
		results.value = [];
		return;
	}

	if (abortController) {
		abortController.abort();
	}
	abortController = new AbortController();

	isLoading.value = true;

	let url = `https://photon.komoot.io/api/?q=${encodeURIComponent(text)}&limit=5&lang=${lang}`;
	if (lat !== undefined && lon !== undefined) {
		url += `&lat=${lat}&lon=${lon}`;
	}

	try {
		const response = await fetch(url, { signal: abortController.signal });
		const data = await response.json();
		results.value = data.features as PhotonFeature[];
		isLoading.value = false;
	} catch (error: unknown) {
		if (error instanceof DOMException && error.name === 'AbortError') {
			return;
		}
		console.error('Photon search failed:', error);
		results.value = [];
		isLoading.value = false;
	}
}

async function searchPhotonReverse(
	lat: number,
	lon: number,
	lang: string
): Promise<PhotonFeature | null> {
	try {
		const response = await fetch(
			`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&lang=${lang}&limit=1`
		);
		const data = await response.json();
		const features = data.features as PhotonFeature[];
		return features.length > 0 ? features[0] : null;
	} catch (error) {
		console.error('Photon reverse search failed:', error);
		return null;
	}
}

function clearSearch(): void {
	query.value = '';
	results.value = [];
	isLoading.value = false;
	if (abortController) {
		abortController.abort();
		abortController = null;
	}
}

function formatAddress(feature: PhotonFeature): string {
	const parts: string[] = [];
	const props = feature.properties;

	const streetPart = [props.street, props.housenumber].filter(Boolean).join(' ');
	if (streetPart) parts.push(streetPart);

	const cityPart = [props.postcode, props.city].filter(Boolean).join(' ');
	if (cityPart) parts.push(cityPart);

	if (props.state) parts.push(props.state);
	if (props.country) parts.push(props.country);

	return parts.join(', ');
}

function getFeatureName(feature: PhotonFeature): string {
	const props = feature.properties;

	if (props.name) return props.name;

	const streetPart = [props.street, props.housenumber].filter(Boolean).join(' ');
	if (streetPart) return streetPart;

	if (props.city) return props.city;

	if (props.county) return props.county;
	if (props.state) return props.state;
	if (props.country) return props.country;

	return '';
}

export function usePhotonSearch() {
	return {
		query,
		results,
		isLoading,
		searchPhoton,
		searchPhotonReverse,
		clearSearch,
		formatAddress,
		getFeatureName
	};
}
