// The v5 browser stores (localStorage keys) a backup has to cover, for the Backup / Restore view, the manual and the
// legacy import hook (GRS-20). v5's own backup (STORE_KEYS, L2829) listed 20 keys: 16 live stores and 4 keys no v5
// code reads or writes (S-backup_tab-2), and missed 5 live stores (S-backup_tab-1). ClearCase keeps all user work in
// work.sqlite and backs up every registered table, so these lists document coverage; they never select what is saved.

/** The 21 live v5 user-work stores, with the ticket whose views own their data in ClearCase. */
export const V5_STORES: readonly { key: string; owner: string; inV5Backup: boolean }[] = Object.freeze([
	{ key: 'ess_dcs_annotations_v1', owner: 'GRS-17', inV5Backup: true },
	{ key: 'ess_dcs_authorities_v1', owner: 'GRS-18', inV5Backup: true },
	{ key: 'ess_dcs_crossexam_v1', owner: 'GRS-18', inV5Backup: true },
	{ key: 'ess_dcs_custom_bundles_v1', owner: 'GRS-19', inV5Backup: true },
	{ key: 'ess_dcs_deadlines_v1', owner: 'GRS-17', inV5Backup: true },
	{ key: 'ess_dcs_disbursements_v1', owner: 'GRS-17', inV5Backup: true },
	{ key: 'ess_dcs_enf_status_v1', owner: 'GRS-18', inV5Backup: true },
	{ key: 'ess_dcs_filings_v1', owner: 'GRS-14', inV5Backup: true },
	{ key: 'ess_dcs_heads_v1', owner: 'GRS-18', inV5Backup: true },
	{ key: 'ess_dcs_info_done_v1', owner: 'GRS-15', inV5Backup: true },
	{ key: 'ess_dcs_payments_v1', owner: 'GRS-16', inV5Backup: true },
	{ key: 'ess_dcs_popia_v1', owner: 'GRS-17', inV5Backup: true },
	{ key: 'ess_dcs_privilege_v1', owner: 'GRS-17', inV5Backup: true },
	{ key: 'ess_dcs_rescan_v1', owner: 'GRS-20', inV5Backup: true },
	{ key: 'ess_dcs_timesheet_v1', owner: 'GRS-17', inV5Backup: true },
	{ key: 'ess_dcs_transcripts_v1', owner: 'GRS-17', inV5Backup: true },
	{ key: 'ess_dcs_bundle_header_v2', owner: 'GRS-19', inV5Backup: false },
	{ key: 'ess_dcs_caselines_docs_v1', owner: 'GRS-19', inV5Backup: false },
	{ key: 'ess_dcs_schedule_co_v1', owner: 'GRS-19', inV5Backup: false },
	{ key: 'ess_dcs_schedule_mode_v1', owner: 'GRS-19', inV5Backup: false },
	{ key: 'ess_dcs_schedule_sel_v1', owner: 'GRS-19', inV5Backup: false },
]);

/** The four keys in v5's STORE_KEYS that no v5 code reads or writes (S-backup_tab-2). A v5 backup may carry them;
 *  the legacy import hook recognises them and hands them to an importer like any other key. */
export const V5_LEGACY_KEYS: readonly string[] = Object.freeze(['ess_dcs_courtbundle_v1', 'ess_dcs_bundle_header_v1', 'ess_dcs_bundle_extents_v1', 'ess_dcs_bundle_overrides_v1']);

/** A v5 browser store key (ess_dcs_<name>_v<n>). */
export const V5_KEY = /^ess_dcs_[a-z0-9_]+_v\d+$/;
