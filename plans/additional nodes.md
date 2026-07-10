Ready to code?

Here is Claude's plan:
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
Plan: Marker Delete + Multi-Type Add/Edit

Context

The marker edit functionality currently only supports fire hydrants. This plan extends it to:
1. Allow users to delete an existing marker from OSM and local cache
2. Allow users to add/edit suction points and water tanks in addition to fire hydrants

 ---
Files to Modify

┌─────────────────────────────────────┬───────────────────────────────────────────────────────────────┐
│                File                 │                            Change                             │
├─────────────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ src/mapHandler/databaseHandler.ts   │ Add deleteMapNode(id)                                         │
├─────────────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ src/store/markerEditStore.ts        │ Add delete logic, markerType computed                         │
├─────────────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ src/components/MarkerInfoHeader.vue │ Extend editAllowed to all 3 emergency types                   │
├─────────────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ src/components/MarkerEditHeader.vue │ Dynamic title + trash icon (edit mode only)                   │
├─────────────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ src/components/MarkerEdit.vue       │ Type selector, conditional form sections, suction/tank fields │
├─────────────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ src/locales/en.json                 │ All new translations                                          │
├─────────────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ src/locales/de.json                 │ All new translations                                          │
└─────────────────────────────────────┴───────────────────────────────────────────────────────────────┘

 ---
Step-by-Step Implementation

1. databaseHandler.ts — Add delete function

Add after getMapNodeById:

export async function deleteMapNode(id: number) {
try {
const tx = (await dbPromise).transaction(markerStoreName, 'readwrite');
await tx.store.delete(id);
await tx.done;
} catch (e) {
console.error(e);
}
}

 ---
2. markerEditStore.ts — Delete marker logic

- Import deleteMapNode from databaseHandler
- Add markerType computed:
  const markerType = computed(() => editableTags.value['emergency'] || 'fire_hydrant');
- Add requestDeleteMarker() — shows alertController confirmation dialog then calls deleteMarker()
- Add deleteMarker():
  async function deleteMarker() {
  const [node] = await OSM.getFeature('node', originalMarker.value.id);
  const change = { create: [], modify: [], delete: [node] };
  await OSM.uploadChangeset(
  { comment: `Remove ${markerType.value} via FireYak ${version}` },
  change
  );
  await deleteMapNode(originalMarker.value.id);
  markerStore.selectMarker(null);  // closes info panel
  cancelEdit();
  // show success toast
  }
- Export markerType and requestDeleteMarker

The delete must update relevantTags changeset comment dynamically (fire_hydrant / suction_point / water_tank).

 ---
3. MarkerInfoHeader.vue — Allow editing all 3 types

Line 24: change editAllowed:
// Before:
const editAllowed = computed(() => markerData.value?.tags?.emergency === 'fire_hydrant');

// After:
const editAllowed = computed(() =>
['fire_hydrant', 'suction_point', 'water_tank'].includes(
markerData.value?.tags?.emergency || ''
)
);

 ---
4. MarkerEditHeader.vue — Dynamic title + trash button

- Add computed import and trashOutline icon import
- Compute title key from current emergency type + add/edit mode:
  const titleKey = computed(() => {
  const type = markerEditStore.editableTags['emergency'] || 'fire_hydrant';
  const mode = markerEditStore.isAdding ? 'add' : 'edit';
  const typeMap: Record<string, string> = {
  fire_hydrant: 'FireHydrant',
  suction_point: 'SuctionPoint',
  water_tank: 'WaterTank',
  };
  return `markerEdit.title.${mode}${typeMap[type] ?? 'FireHydrant'}`;
  });
- In template, replace current title with {{ t(titleKey) }}
- Add trash icon button (only v-if="markerEditStore.isEditing") in slot="start":
  <ion-button v-if="markerEditStore.isEditing" @click="markerEditStore.requestDeleteMarker()" color="danger">
  <ion-icon :icon="trashOutline" />
  </ion-button>

 ---
5. MarkerEdit.vue — Multi-type form

Script additions:
- Add computed for emergencyType = computed(() => markerEditStore.editableTags['emergency'] || 'fire_hydrant')
- Add onTypeChange() handler that clears tags from other types when type selector changes (removes fire_hydrant:* tags when switching away, removes water_tank:volume/location when switching away, etc.)
- Add accessOptions = ['yes', 'private', 'permissive', 'no']
- Add waterSources (already in locales: river, lake, pond, stream, well, tank, reservoir, cistern, water_works)
- Add locationOptions = ['overground', 'underground']

Template structure:
1. Type selector (v-if="markerEditStore.isAdding") — ion-select bound to editableTags['emergency'], options: fire_hydrant / suction_point / water_tank, with @ionChange="onTypeChange"
2. Fire Hydrant section (v-if="emergencyType === 'fire_hydrant'") — existing fields unchanged
3. Couplings section (v-if="emergencyType === 'fire_hydrant'") — existing, unchanged
4. Suction Point section (v-if="emergencyType === 'suction_point'"):
- water_source select (with existing locale values: river, lake, pond, stream, etc.)
- access select (yes, private, permissive, no)
- name text input
5. Water Tank section (v-if="emergencyType === 'water_tank'"):
- water_tank:volume number input (litres)
- location select (overground, underground)
- access select (yes, private, permissive, no)
- name text input
6. Operator & Ref section — shown for all types (remove existing v-if if any)
7. Unknown tags section — unchanged, shown for all types

Update relevantTags array to include water_tank:volume (already present) and ensure access, location, water_source, name are listed.

 ---
6. Locale additions (en.json and de.json)

markerEdit.title — new keys (keep existing add/edit for backwards compat):

┌──────────────────┬──────────────────────┬─────────────────────────┐
│       Key        │          EN          │           DE            │
├──────────────────┼──────────────────────┼─────────────────────────┤
│ addFireHydrant   │ "Add Fire Hydrant"   │ "Hydrant hinzufügen"    │
├──────────────────┼──────────────────────┼─────────────────────────┤
│ editFireHydrant  │ "Edit Fire Hydrant"  │ "Hydrant bearbeiten"    │
├──────────────────┼──────────────────────┼─────────────────────────┤
│ addSuctionPoint  │ "Add Suction Point"  │ "Saugstelle hinzufügen" │
├──────────────────┼──────────────────────┼─────────────────────────┤
│ editSuctionPoint │ "Edit Suction Point" │ "Saugstelle bearbeiten" │
├──────────────────┼──────────────────────┼─────────────────────────┤
│ addWaterTank     │ "Add Water Tank"     │ "Wassertank hinzufügen" │
├──────────────────┼──────────────────────┼─────────────────────────┤
│ editWaterTank    │ "Edit Water Tank"    │ "Wassertank bearbeiten" │
└──────────────────┴──────────────────────┴─────────────────────────┘

markerEdit.deleteDialog:

┌─────────┬──────────────────────────────────────────────────────────────────────────────────────────────────────┬────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│   Key   │                                                  EN                                                  │                                                                 DE                                                                 │
├─────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ title   │ "Remove from OpenStreetMap"                                                                          │ "Von OpenStreetMap entfernen"                                                                                                      │
├─────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ message │ "Are you sure you want to permanently remove this marker from OpenStreetMap? This action cannot be   │ "Sind Sie sicher, dass Sie diesen Marker dauerhaft von OpenStreetMap entfernen möchten? Diese Aktion kann nicht rückgängig gemacht │
│         │ undone."                                                                                             │  werden."                                                                                                                          │
├─────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ confirm │ "Remove"                                                                                             │ "Entfernen"                                                                                                                        │
└─────────┴──────────────────────────────────────────────────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

markerEdit.buttons.delete:

┌───────────────────┬─────────────────────┐
│        EN         │         DE          │
├───────────────────┼─────────────────────┤
│ "Remove from OSM" │ "Aus OSM entfernen" │
└───────────────────┴─────────────────────┘

markerEdit.messages (new entries):

┌───────────────┬────────────────────────────────────────────┬────────────────────────────────────────────────────────────┐
│      Key      │                     EN                     │                             DE                             │
├───────────────┼────────────────────────────────────────────┼────────────────────────────────────────────────────────────┤
│ deleteSuccess │ "Successfully removed from OpenStreetMap!" │ "Erfolgreich von OpenStreetMap entfernt!"                  │
├───────────────┼────────────────────────────────────────────┼────────────────────────────────────────────────────────────┤
│ deleteError   │ "Failed to remove. Please try again."      │ "Entfernen fehlgeschlagen. Bitte versuchen Sie es erneut." │
└───────────────┴────────────────────────────────────────────┴────────────────────────────────────────────────────────────┘

markerEdit.hints (new entries):

┌─────────────┬───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┬────────────────────────────────────────────────────────────────────────────────┐
│     Key     │                                                                  EN                                                                   │                                       DE                                       │
├─────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
│ markerType  │ "Select the type of water source you want to add."                                                                                    │ "Wählen Sie die Art der Wasserentnahmestelle aus."                             │
├─────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
│ waterSource │ "The type of water body at this suction point (e.g., river, lake, pond). Helps fire departments identify the available water source." │ "Die Art des Gewässers an dieser Saugstelle (z.B. Fluss, See, Teich)."         │
├─────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
│ access      │ "Indicates who can access this water source. 'Public' for open access, 'Private' for restricted."                                     │ "Gibt an, wer Zugang zu dieser Wasserentnahmestelle hat."                      │
├─────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
│ volume      │ "Total storage volume of the water tank in litres (e.g. 50000)."                                                                      │ "Gesamtfassungsvermögen des Wassertanks in Litern (z.B. 50000)."               │
├─────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
│ location    │ "Whether the tank is located above or below ground."                                                                                  │ "Ob der Tank ober- oder unterirdisch aufgestellt ist."                         │
├─────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
│ name        │ "A distinctive name for this water source if it has one."                                                                             │ "Ein charakteristischer Name für diese Wasserentnahmestelle, falls vorhanden." │
└─────────────┴───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────────────────────────┘

markerInfo.values (new entries):

"location": {
"overground": "Above Ground",   // DE: "Überirdisch"
"underground": "Underground"    // DE: "Unterirdisch"
},
"access": {
"yes": "Public",                // DE: "Öffentlich"
"private": "Private",           // DE: "Privat"
"permissive": "Permissive",     // DE: "Zugänglich"
"no": "No Access"               // DE: "Kein Zugang"
}

 ---
7. markerEditStore.ts — Remove empty tags on save

Currently, saveMarker() does:
const tags = { ...editableTags.value };
// ...
node.tags = { ...node.tags, ...tags };  // merge, doesn't delete cleared tags

Problem: If a user clears a tag to "" it stays as an empty string in OSM rather than being removed.

Fix: Filter empty strings before saving, and for the modify case replace tags entirely instead of merging (to allow deletion of previously-existing tags):

// Filter out empty strings
const finalTags = Object.fromEntries(
Object.entries(editableTags.value).filter(([, v]) => v !== '' && v != null)
);

// For create — use finalTags directly (already the case via `tags` variable)

// For modify — replace entirely instead of merge:
node.tags = finalTags;  // NOT { ...node.tags, ...tags }

This works correctly because startEditing() copies ALL existing tags into editableTags. Tags the user didn't touch remain present with their original values. Tags the user cleared become "" and are filtered out. Unknown/extra tags shown in the "Other
Tags" section are also preserved or cleared by the user.

 ---
Key Architectural Notes

- emergencyType computed in MarkerEdit.vue derives from editableTags['emergency'], so editing an existing suction_point or water_tank automatically shows the correct form
- onTypeChange() cleans up stale tags when switching type during add mode to avoid polluting OSM data
- Delete is accessible only from edit mode (not add), via the trash icon in MarkerEditHeader.vue
- After successful delete: markerStore.selectMarker(null) closes the info panel and cancelEdit() closes the edit panel
- Error handling follows same pattern as saveMarker(): catch block shows danger toast

 ---
Verification

1. Add flow: Tap map → add dialog opens → type selector defaults to fire_hydrant → switch to suction_point → header title updates → suction point fields shown → save → OSM changeset created with emergency=suction_point
2. Edit flow: Select existing suction_point → edit button visible → form shows suction point fields → save succeeds
3. Delete flow: Select existing marker → edit → trash icon visible in header → tap trash → confirmation dialog → confirm → deleted from OSM API + IndexedDB → info panel closes
4. Locale: All new strings appear in both EN and DE with correct translations
5. Type safety: Switching types clears stale tags (verify no fire_hydrant:type tag when saving a water_tank)
