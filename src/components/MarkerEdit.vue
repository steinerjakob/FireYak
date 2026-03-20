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
	IonNote,
	IonItemGroup,
	IonItemDivider,
	IonTextarea,
	IonDatetime,
	IonDatetimeButton,
	IonModal
} from '@ionic/vue';
import { saveOutline, closeOutline, logInOutline } from 'ionicons/icons';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMarkerEditStore } from '@/store/markerEditStore';
import { useOsmAuthStore } from '@/store/osmAuthStore';

const markerEditStore = useMarkerEditStore();
const osmAuthStore = useOsmAuthStore();
const { t } = useI18n();

const hydrantTypes = ['pillar', 'underground', 'wall' /*, 'pond'*/];
const hydrantPositions = ['sidewalk', 'lane', 'parking_lot', 'green', 'street'];
const waterSources = [
	'main',
	'pond',
	'stream',
	'river',
	'lake',
	'well',
	'tank',
	'reservoir',
	'cistern',
	'water_works'
];
const locationOptions = ['overground', 'underground'];
const accessOptions = ['yes', 'private', 'permissive', 'no'];

const emergencyType = computed(() => markerEditStore.editableTags['emergency'] || 'fire_hydrant');

const onTypeChange = () => {
	const type = markerEditStore.editableTags['emergency'];
	if (type !== 'fire_hydrant') {
		delete markerEditStore.editableTags['fire_hydrant:type'];
		delete markerEditStore.editableTags['fire_hydrant:diameter'];
		delete markerEditStore.editableTags['fire_hydrant:pressure'];
		delete markerEditStore.editableTags['fire_hydrant:flow_capacity'];
		delete markerEditStore.editableTags['flow_rate'];
		delete markerEditStore.editableTags['fire_hydrant:position'];
		delete markerEditStore.editableTags['couplings'];
		delete markerEditStore.editableTags['couplings:type'];
		delete markerEditStore.editableTags['couplings:diameters'];
	}
	if (type !== 'water_tank') {
		delete markerEditStore.editableTags['water_tank:volume'];
		delete markerEditStore.editableTags['location'];
		delete markerEditStore.editableTags['capacity'];
	}
	if (type !== 'suction_point') {
		delete markerEditStore.editableTags['water_source'];
	}
	if (type === 'fire_hydrant' && !markerEditStore.editableTags['fire_hydrant:type']) {
		markerEditStore.editableTags['fire_hydrant:type'] = 'pillar';
	}
};

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
	'location',
	'access',
	'ref',
	'operator',
	'name',
	'amenity',
	'description',
	'note',
	'survey:date'
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
		<!-- Marker Type Selector (add mode only) -->
		<ion-item-group v-if="markerEditStore.isAdding">
			<ion-item-divider>
				<ion-label>{{ t('markerEdit.labels.markerType') }}</ion-label>
			</ion-item-divider>
			<ion-item lines="none">
				<ion-select
					fill="outline"
					label-placement="stacked"
					:label="t('markerEdit.labels.markerType')"
					v-model="markerEditStore.editableTags['emergency']"
					@ionChange="onTypeChange"
					:helper-text="t('markerEdit.hints.markerType')"
				>
					<ion-select-option value="fire_hydrant">{{
						t('markerInfo.title.fireHydrant')
					}}</ion-select-option>
					<ion-select-option value="suction_point">{{
						t('markerInfo.title.suctionPoint')
					}}</ion-select-option>
					<ion-select-option value="water_tank">{{
						t('markerInfo.title.waterTank')
					}}</ion-select-option>
				</ion-select>
			</ion-item>
		</ion-item-group>

		<!-- ==================== FIRE HYDRANT FIELDS ==================== -->
		<ion-item-group v-if="emergencyType === 'fire_hydrant'">
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
					<ion-select-option v-for="type in hydrantTypes" :key="type" :value="type">
						{{ t(`markerInfo.values.fire_hydrant:type.${type}`) }}
					</ion-select-option>
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
				<ion-input
					fill="outline"
					label-placement="stacked"
					:label="t('markerInfo.tags.pressure')"
					v-model="markerEditStore.editableTags['fire_hydrant:pressure']"
					placeholder="6, yes, suction..."
					:helper-text="t('markerEdit.hints.pressure')"
				></ion-input>
			</ion-item>

			<!-- Flow Capacity -->
			<ion-item lines="none">
				<ion-input
					fill="outline"
					label-placement="stacked"
					:label="t('markerInfo.tags.flowCapacity') + ` (l/min)`"
					v-model="markerEditStore.editableTags['flow_rate']"
					placeholder="800 l/min, 1200 l/min..."
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
					<ion-select-option v-for="pos in hydrantPositions" :key="pos" :value="pos">
						{{ t(`markerInfo.values.fire_hydrant:position.${pos}`) }}
					</ion-select-option>
				</ion-select>
			</ion-item>
		</ion-item-group>

		<!-- Couplings (fire hydrant only) -->
		<ion-item-group v-if="emergencyType === 'fire_hydrant'">
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

		<!-- ==================== SUCTION POINT FIELDS ==================== -->
		<ion-item-group v-if="emergencyType === 'suction_point'">
			<ion-item-divider>
				<ion-label>{{ t('markerInfo.title.suctionPoint') }}</ion-label>
			</ion-item-divider>

			<!-- Water Source -->
			<ion-item lines="none">
				<ion-select
					fill="outline"
					label-placement="stacked"
					:label="t('markerInfo.tags.waterSource')"
					v-model="markerEditStore.editableTags['water_source']"
					:placeholder="t('markerInfo.tags.waterSource')"
					:helper-text="t('markerEdit.hints.waterSource')"
				>
					<ion-select-option v-for="ws in waterSources" :key="ws" :value="ws">
						{{ t(`markerInfo.values.water_source.${ws}`) }}
					</ion-select-option>
				</ion-select>
			</ion-item>

			<!-- Access -->
			<ion-item lines="none">
				<ion-select
					fill="outline"
					label-placement="stacked"
					:label="t('markerInfo.tags.access')"
					v-model="markerEditStore.editableTags['access']"
					:placeholder="t('markerInfo.tags.access')"
					:helper-text="t('markerEdit.hints.access')"
				>
					<ion-select-option v-for="a in accessOptions" :key="a" :value="a">
						{{ t(`markerInfo.values.access.${a}`) }}
					</ion-select-option>
				</ion-select>
			</ion-item>

			<!-- Name -->
			<ion-item lines="none">
				<ion-input
					fill="outline"
					label-placement="stacked"
					:label="t('markerInfo.tags.name')"
					v-model="markerEditStore.editableTags['name']"
					:helper-text="t('markerEdit.hints.name')"
				></ion-input>
			</ion-item>
		</ion-item-group>

		<!-- ==================== WATER TANK FIELDS ==================== -->
		<ion-item-group v-if="emergencyType === 'water_tank'">
			<ion-item-divider>
				<ion-label>{{ t('markerInfo.title.waterTank') }}</ion-label>
			</ion-item-divider>

			<!-- Volume -->
			<ion-item lines="none">
				<ion-input
					type="number"
					fill="outline"
					label-placement="stacked"
					:label="t('markerInfo.tags.volume') + ' (l)'"
					v-model="markerEditStore.editableTags['water_tank:volume']"
					placeholder="10000, 50000..."
					:helper-text="t('markerEdit.hints.volume')"
				></ion-input>
			</ion-item>

			<!-- Location -->
			<ion-item lines="none">
				<ion-select
					fill="outline"
					label-placement="stacked"
					:label="t('markerInfo.tags.location')"
					v-model="markerEditStore.editableTags['location']"
					:placeholder="t('markerInfo.tags.location')"
					:helper-text="t('markerEdit.hints.tankLocation')"
				>
					<ion-select-option v-for="loc in locationOptions" :key="loc" :value="loc">
						{{ t(`markerInfo.values.location.${loc}`) }}
					</ion-select-option>
				</ion-select>
			</ion-item>

			<!-- Access -->
			<ion-item lines="none">
				<ion-select
					fill="outline"
					label-placement="stacked"
					:label="t('markerInfo.tags.access')"
					v-model="markerEditStore.editableTags['access']"
					:placeholder="t('markerInfo.tags.access')"
					:helper-text="t('markerEdit.hints.access')"
				>
					<ion-select-option v-for="a in accessOptions" :key="a" :value="a">
						{{ t(`markerInfo.values.access.${a}`) }}
					</ion-select-option>
				</ion-select>
			</ion-item>

			<!-- Name -->
			<ion-item lines="none">
				<ion-input
					fill="outline"
					label-placement="stacked"
					:label="t('markerInfo.tags.name')"
					v-model="markerEditStore.editableTags['name']"
					:helper-text="t('markerEdit.hints.name')"
				></ion-input>
			</ion-item>
		</ion-item-group>

		<!-- ==================== SHARED: OPERATOR & REF ==================== -->
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
		<ion-item-group>
			<ion-item-divider>
				<ion-label>{{ t('markerInfo.tags.description') }}</ion-label>
			</ion-item-divider>

			<ion-item lines="none">
				<ion-textarea
					fill="outline"
					label-placement="stacked"
					:label="t('markerInfo.tags.description')"
					v-model="markerEditStore.editableTags['description']"
					auto-grow
				></ion-textarea>
			</ion-item>
		</ion-item-group>

		<!-- ==================== SURVEY DATE ==================== -->
		<ion-item-group>
			<ion-item-divider>
				<ion-label>{{ t('markerInfo.tags.surveyDate') }}</ion-label>
			</ion-item-divider>

			<ion-item lines="none">
				<ion-label>
					<p>{{ t('markerEdit.hints.surveyDate') }}</p>
				</ion-label>
				<ion-datetime-button datetime="survey-date" slot="end"></ion-datetime-button>
				<ion-modal :keep-contents-mounted="true">
					<ion-datetime
						id="survey-date"
						presentation="date"
						:value="markerEditStore.editableTags['survey:date']"
						@ionChange="
							(e: CustomEvent) =>
								(markerEditStore.editableTags['survey:date'] = e.detail.value?.split('T')[0])
						"
						:max="new Date().toISOString().split('T')[0]"
					></ion-datetime>
				</ion-modal>
			</ion-item>
		</ion-item-group>

		<!-- Unknown / Other Tags -->
		<ion-item-group v-if="getOtherTags().length > 0">
			<ion-item-divider>
				<ion-label>{{ t('markerInfo.messages.noAdditionalInfo') }}</ion-label>
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
