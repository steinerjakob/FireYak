<script setup lang="ts">
import { computed, ref } from 'vue';
import { IonButton, IonCard, IonIcon } from '@ionic/vue';
import { close } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import RouteDetailsContent from '@/components/RouteDetailsContent.vue';
import { useRouteDetails, useRouteDetailsView } from '@/composable/routeDetails';
import { useDefaultStore } from '@/store/defaultStore';
import { MARKER_THUMBNAIL_PX, useMarkerThumbnail } from '@/composable/markerThumbnail';

/**
 * The floating route details card of the side-panel layout (plan §6.8):
 * opens for a drawn route and on a tap on the line or its badge; a tapped
 * coloured or dashed run opens it focused on that stretch. Sits bottom left
 * beside the side panel and the marker's photo thumbnail. On phones the
 * details live in the bottom sheet instead (`RouteSheetSection.vue`), so
 * nothing floats over the map there.
 */

const { t } = useI18n();
const details = useRouteDetails();
const view = useRouteDetailsView(() => details.source.value);
const { visibleMapView } = storeToRefs(useDefaultStore());

const { thumbnailShown } = useMarkerThumbnail();

/** Beside the side panel; right of the marker's photo thumbnail when one shows (both sit bottom left). */
const positionStyle = computed(() => {
	const left = visibleMapView.value.x + 16 + (thumbnailShown.value ? MARKER_THUMBNAIL_PX : 0);
	return {
		left: `${left}px`,
		maxWidth: `calc(100vw - ${left + 16}px)`,
		bottom: 'calc(var(--ion-safe-area-bottom, 0px) + 16px)'
	};
});

const titleId = ref(`route-details-title-${Math.random().toString(36).slice(2, 8)}`);
</script>

<template>
	<ion-card
		v-if="view"
		class="route-details"
		:style="positionStyle"
		role="dialog"
		:aria-labelledby="titleId"
	>
		<div class="route-details-header">
			<h2 :id="titleId">{{ view.title }}</h2>
			<ion-button
				fill="clear"
				size="small"
				:title="t('route.details.close')"
				:aria-label="t('route.details.close')"
				@click="details.closeDetails()"
			>
				<ion-icon slot="icon-only" :icon="close" />
			</ion-button>
		</div>
		<div class="route-details-body">
			<RouteDetailsContent
				:view="view"
				:focus-id="details.focusId.value"
				@select="details.focusStretch"
			/>
		</div>
	</ion-card>
</template>

<style scoped>
.route-details {
	position: fixed;
	z-index: 1001;
	width: 360px;
	max-width: calc(100vw - 16px);
	max-height: 60vh;
	margin: 0;
	display: flex;
	flex-direction: column;
	overflow: hidden;
	border-radius: 16px;
	--background: var(--md-sys-surface-container-low, var(--ion-background-color));
	--color: var(--md-sys-on-surface, var(--ion-text-color));
	background: var(--background);
	color: var(--color);
	box-shadow: var(--md-sys-level3, 0 4px 16px rgba(0, 0, 0, 0.25));
}

.route-details-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 4px 4px 0 16px;
	flex-shrink: 0;
}

.route-details-header h2 {
	margin: 0;
	font: var(--md-sys-title-medium, 500 16px / 24px sans-serif);
}

.route-details-body {
	overflow-y: auto;
	padding: 0 16px 12px;
}
</style>
