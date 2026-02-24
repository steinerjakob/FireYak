<script setup lang="ts">
import {
	IonButton,
	IonIcon,
	IonItem,
	IonLabel,
	IonList,
	IonInput,
	IonSelect,
	IonSelectOption,
	IonTextarea,
	IonNote,
	IonItemGroup,
	IonItemDivider
} from '@ionic/vue';
import { saveOutline, closeOutline, logInOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import { useMarkerEditStore } from '@/store/markerEditStore';
import { useOsmAuthStore } from '@/store/osmAuthStore';

const markerEditStore = useMarkerEditStore();
const osmAuthStore = useOsmAuthStore();
const { t } = useI18n();

const hydrantTypes = ['pillar', 'underground', 'wall'/*, 'pond'*/];
const hydrantPositions = ['sidewalk', 'lane', 'parking_lot', 'green', 'street'];
const pressures = ['pressurised', 'suction', 'gravity'];

const relevantTags = [
	'emergency',
	'fire_hydrant:type',
	'fire_hydrant:diameter',
	'fire_hydrant:pressure',
	'fire_hydrant:flow_capacity',
	'fire_hydrant:position',
	'flow_rate',
	'couplings',
	'couplings:type',
	'couplings:diameters',
	'water_source',
	'capacity',
	'volume',
	'water_tank:volume',
	'water_volume',
	'ref',
	'operator',
	'name',
	'amenity',
	'addr:street',
	'addr:housenumber',
	'addr:city',
	'addr:postcode',
	'description',
	'note',
	'survey:date',
	'access',
	'location'
];

const getOtherTags = () => {
	return Object.entries(markerEditStore.editableTags)
		.filter(([key]) => !relevantTags.includes(key))
		.map(([key, value]) => ({ key, value }));
};

const save = async () => {
	await markerEditStore.saveMarker();
};

const cancel = () => {
	markerEditStore.cancelEdit();
};

const login = () => {
	osmAuthStore.login();
};
</script>

<template>
	<ion-list class="edit-list">
		<ion-item-group>
			<ion-item-divider>
				<ion-label>{{ t('markerInfo.title.fireHydrant') }}</ion-label>
			</ion-item-divider>

			<!-- Type -->
			<ion-item lines="none">
				<ion-select
					fill="outline"
					label-placement="stacked"
					:label="t('markerInfo.tags.hydrantType')"
					v-model="markerEditStore.editableTags['fire_hydrant:type']"
					:placeholder="t('markerInfo.tags.hydrantType')"
					:helper-text="t('markerEdit.hints.type')"
				>
					<ion-selectOption v-for="type in hydrantTypes" :key="type" :value="type">
						{{ t(`markerInfo.values.fire_hydrant:type.${type}`) }}
					</ion-selectOption>
				</ion-select>
			</ion-item>

			<!-- Diameter -->
			<ion-item lines="none">
				<ion-input
					type="number"
					fill="outline"
					label-placement="stacked"
					:label="t('markerInfo.tags.diameter') + `(mm)`"
					v-model="markerEditStore.editableTags['fire_hydrant:diameter']"
					placeholder="80, 100, 150..."
					:helper-text="t('markerEdit.hints.diameter')"
				></ion-input>
			</ion-item>

			<!-- Pressure -->
			<ion-item lines="none">
				<ion-select
					fill="outline"
					label-placement="stacked"
					:label="t('markerInfo.tags.pressure')"
					v-model="markerEditStore.editableTags['fire_hydrant:pressure']"
					:placeholder="t('markerInfo.tags.pressure')"
					:helper-text="t('markerEdit.hints.pressure')"
				>
					<ion-selectOption v-for="p in pressures" :key="p" :value="p">
						{{ t(`markerInfo.values.fire_hydrant:pressure.${p}`) }}
					</ion-selectOption>
				</ion-select>
			</ion-item>

			<!-- Flow Capacity -->
			<ion-item lines="none">
				<ion-input
					type="number"
					fill="outline"
					label-placement="stacked"
					:label="t('markerInfo.tags.flowCapacity') + ` (l/min)`"
					v-model="markerEditStore.editableTags['fire_hydrant:flow_capacity']"
					placeholder="800, 1200..."
					:helper-text="t('markerEdit.hints.flowCapacity')"
				></ion-input>
			</ion-item>

			<!-- Position -->
			<ion-item lines="none">
				<ion-select
					fill="outline"
					label-placement="stacked"
					:label="t('markerInfo.tags.position')"
					v-model="markerEditStore.editableTags['fire_hydrant:position']"
					:placeholder="t('markerInfo.tags.position')"
					:helper-text="t('markerEdit.hints.position')"
				>
					<ion-selectOption v-for="pos in hydrantPositions" :key="pos" :value="pos">
						{{ t(`markerInfo.values.fire_hydrant:position.${pos}`) }}
					</ion-selectOption>
				</ion-select>
			</ion-item>
		</ion-item-group>

		<ion-item-group>
			<ion-item-divider>
				<ion-label>{{ t('markerInfo.tags.couplings') }}</ion-label>
			</ion-item-divider>

			<!-- Couplings Count -->
			<ion-item lines="none">
				<ion-input
					type="number"
					fill="outline"
					label-placement="stacked"
					:label="t('markerInfo.tags.couplings')"
					v-model="markerEditStore.editableTags['couplings']"
					placeholder="1, 2, 3..."
					:helper-text="t('markerEdit.hints.couplings')"
				></ion-input>
			</ion-item>

			<!-- Coupling Type -->
			<ion-item lines="none">
				<ion-input
					fill="outline"
					label-placement="stacked"
					:label="t('markerInfo.tags.couplingType')"
					v-model="markerEditStore.editableTags['couplings:type']"
					placeholder="Storz, NH, BS 336..."
					:helper-text="t('markerEdit.hints.couplingType')"
				></ion-input>
			</ion-item>

			<!-- Coupling Diameters -->
			<ion-item lines="none">
				<ion-input
					fill="outline"
					label-placement="stacked"
					:label="t('markerInfo.tags.couplingDiameters')"
					v-model="markerEditStore.editableTags['couplings:diameters']"
					placeholder="A;B;C or 110;75;52"
					:helper-text="t('markerEdit.hints.couplingDiameters')"
				></ion-input>
			</ion-item>
		</ion-item-group>

		<ion-item-group>
			<ion-item-divider>
				<ion-label
					>{{ t('markerInfo.tags.operator') }} &
					{{ t('markerInfo.tags.referenceNumber') }}</ion-label
				>
			</ion-item-divider>

			<!-- Operator -->
			<ion-item lines="none">
				<ion-input
					fill="outline"
					label-placement="stacked"
					:label="t('markerInfo.tags.operator')"
					v-model="markerEditStore.editableTags['operator']"
					:helper-text="t('markerEdit.hints.operator')"
				></ion-input>
			</ion-item>

			<!-- Ref -->
			<ion-item lines="none">
				<ion-input
					fill="outline"
					label-placement="stacked"
					:label="t('markerInfo.tags.referenceNumber')"
					v-model="markerEditStore.editableTags['ref']"
					:helper-text="t('markerEdit.hints.ref')"
				></ion-input>
			</ion-item>
		</ion-item-group>

<!--		<ion-item-group>
			<ion-item-divider>
				<ion-label>{{ t('markerInfo.tags.description') }}</ion-label>
			</ion-item-divider>

			&lt;!&ndash; Note &ndash;&gt;
			<ion-item lines="none">
				<ion-textarea
					fill="outline"
					label-placement="stacked"
					:label="t('markerInfo.tags.note')"
					v-model="markerEditStore.editableTags['note']"
					auto-grow
				></ion-textarea>
			</ion-item>

			&lt;!&ndash; Description &ndash;&gt;
			<ion-item lines="none">
				<ion-textarea
					fill="outline"
					label-placement="stacked"
					:label="t('markerInfo.tags.description')"
					v-model="markerEditStore.editableTags['description']"
					auto-grow
				></ion-textarea>
			</ion-item>
		</ion-item-group>-->

		<!-- Unknown / Other Tags -->
		<ion-item-group v-if="getOtherTags().length > 0">
			<ion-item-divider>
				<ion-label
					>{{ t('markerInfo.messages.noAdditionalInfo') }}</ion-label
				>
			</ion-item-divider>

			<ion-item lines="none" v-for="tag in getOtherTags()" :key="tag.key">
				<ion-input
					fill="outline"
					label-placement="stacked"
					:label="tag.key"
					v-model="markerEditStore.editableTags[tag.key]"
				></ion-input>
			</ion-item>
		</ion-item-group>

		<!-- Auth & Action Buttons -->
		<div class="ion-padding action-buttons">
			<template v-if="!osmAuthStore.isAuthenticated">
				<ion-button expand="block" color="secondary" @click="login">
					<ion-icon slot="start" :icon="logInOutline"></ion-icon>
					{{ t('markerEdit.buttons.login') }}
				</ion-button>
				<ion-note class="ion-text-center ion-margin-top" style="display: block">
					{{ t('markerEdit.hints.loginRequired') }}
				</ion-note>
			</template>
			<template v-else>
				<ion-button expand="block" color="primary" @click="save">
					<ion-icon slot="start" :icon="saveOutline"></ion-icon>
					{{ t('markerEdit.buttons.save') }}
				</ion-button>
			</template>
			<ion-button expand="block" fill="outline" @click="cancel">
				<ion-icon slot="start" :icon="closeOutline"></ion-icon>
				{{ t('markerEdit.buttons.cancel') }}
			</ion-button>
		</div>
	</ion-list>
</template>

<style scoped>
.edit-list {
	background: transparent;
}

.edit-list ion-input,
.edit-list ion-select,
.edit-list ion-textarea {
	width: 100%;
	padding-top: 10px !important;
}

/* ... existing code ... */
ion-item-divider {
	--background: transparent;
	--padding-top: 16px;
	--padding-bottom: 8px;
	font-weight: bold;
}


.action-buttons {
	display: flex;
	flex-direction: column;
	gap: 8px;
}
</style>
