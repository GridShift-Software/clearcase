// v5 spec: Legality & SIU Risk (GRS-18 r2, D12). The documents card's caption carries the count in its text, which the
// register can only pin as a shape; split the count into a KPI of its own so parity compares it value by value. The app
// adapter applies the same split.

/** The caption of the documents card, with its count; v5 prefixes case wording, the app does not. */
const CAPTION = /^(.*\bdocuments in the bundle) \((\d[\d,]*)\)$/i;

/** Move the count out of the documents caption into the KPI `documents_in_the_bundle_count`. */
export function splitBundleCount(raw) {
	for (const p of raw.paragraphs) {
		const m = CAPTION.exec(p.text.trim());
		if (!m) continue;
		p.text = m[1];
		raw.kpis.push({ label: 'Documents in the bundle (count)', value: m[2], sub: '' });
		return;
	}
}

export default { postRaw: splitBundleCount };
