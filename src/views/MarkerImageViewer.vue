<template>
	<ion-page>
		<ion-content :fullscreen="true">
			<div id="container">
				<div id="photoviewer-container"></div>
			</div>
		</ion-content>
	</ion-page>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useIonRouter } from '@ionic/vue';
import { IonContent, IonPage } from '@ionic/vue';
import {
	PhotoViewer,
	Image,
	ViewerOptions,
	capEchoResult,
	capShowResult,
	capShowOptions
} from '@capacitor-community/photoviewer';
import { fetchMediaWikiFiles, ImageInfo } from '@/mapHandler/markerImageHandler';
import { useRoute } from 'vue-router';

const viewerOptions: ViewerOptions = {
	customHeaders: {
		accept: 'image/jpeg, image/png, image/gif, image/webp, image/svg+xml, image/*;q=0.8, */*;q=0.5',
		cookie: 'session=foo;'
	},
	share: false,
	title: false
};

const ionRouter = useIonRouter();
const route = useRoute();
let listenerExit: any;
const pvPlugin: any = PhotoViewer;

const addListener = async () => {
	listenerExit = await pvPlugin.addListener('jeepCapPhotoViewerExit', (e: any) => {
		const data: any = {};
		data.result = e.result;
		data.imageIndex = e.imageIndex;
		data.message = e.message;
		console.log('jeepCapPhotoViewerExit', data);
		if (ionRouter.canGoBack()) {
			ionRouter.back();
		}
	});
};

async (value: string): Promise<capEchoResult> => {
	const val: any = {};
	val.value = value;
	return await pvPlugin.echo(val);
};

const show = async (
	images: Image[],
	mode: string,
	startFrom: number,
	options?: ViewerOptions
): Promise<capShowResult> => {
	const opts: capShowOptions = {
		images: images,
		mode: images.length === 1 ? 'one' : mode,
		startFrom: startFrom
	};
	if (options != null && Object.keys(options).length != 0) {
		opts.options = options;
	}
	try {
		const ret = await pvPlugin.show(opts);
		return Promise.resolve(ret);
	} catch (err: any) {
		const ret: capShowResult = {} as capShowResult;
		ret.result = false;
		ret.message = err.message;
		return Promise.resolve(ret);
	}
};

onMounted(async () => {
	const header = document.querySelector('.viewer-header');
	header?.classList.add('hidden');

	const imageData = await fetchMediaWikiFiles(parseInt(route.params.relatedId as string));
	const imageDataList: ImageInfo[] = [];
	imageData.forEach((image) => {
		imageDataList.push(...image.imageinfo);
	});

	const imagesToShow: Image[] = imageDataList.map((image) => {
		return {
			url: image.url
		};
	});
	const mode = 'gallery';
	const startFrom = 0;

	await addListener();

	await show(imagesToShow, mode, startFrom, viewerOptions);
});

onUnmounted(async () => {
	await listenerExit.remove();
});
</script>

<style scoped>
#container {
	position: absolute;
	left: var(--ion-safe-area-left, 0);
	right: var(--ion-safe-area-right, 0);
	top: var(--ion-safe-area-top, 0);
	bottom: var(--ion-safe-area-bottom, 0);
}
</style>
