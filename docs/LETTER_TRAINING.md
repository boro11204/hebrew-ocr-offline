# Letter practice (offline)

Open `letter-training.html` from the browser UI or click **Letter practice** on the OCR page. The feature reuses `engine.js` / its local Tesseract.js worker and the bundled `heb4` and `heb_rashi7` models. It accepts one JPG, PNG or WEBP page (30 MB / 50 MP maximum); it does not send the page, text, crops or profile to a server.

The training view reads word boxes and word confidence from Tesseract. Character cuts are **not** supplied by the OCR engine. Instead, a conservative vertical ink projection only offers a word when separated ink spans match the recognized Hebrew letter count and pass width checks. Joined/touching letters, marks, and imperfect boxes can still fool this heuristic, so the page is shown beside the crops and users must confirm every label. Word confidence is only a rough review ordering, never claimed to be a character confidence score.

Profiles store a versioned, validated list of confirmed labels and 24×32 binary glyph signatures in localStorage. Import/export is JSON; import enforces size, count, label, model, signature and bitmap limits. Examples stay on the device unless the user exports them. At least three confirmed examples for each of two labels, a nearest-class median Hamming distance <= 0.10, and a class-distance margin >= 0.12 are required before a local suggestion appears. Matching never mixes the square and Rashi models. These thresholds are conservative engineering heuristics, **not calibrated probability/confidence**. Suggestions are shown in an editable transcript and are not considered confirmed labels or model training.

The existing general OCR pipeline/models are intentionally unchanged. This does not retrain Tesseract and does not yet send profile suggestions into the main OCR transcript, CLI, or PDF workflow. There is no measured accuracy gain: no per-letter held-out benchmark was available or run.

## Tests

From the repository root, with Node.js 18 or newer:

```sh
node --test tests/letter-training-core.test.mjs
node --check docs/letter-training.js
node --check docs/letter-training-core.js
```

The profile tests cover schema validation/limits, strict segmentation valleys, minimum examples, ambiguous/distant matches, script separation, and one-to-one text correction. A public-domain Vilna scan can be used for manual exploratory review; no benchmark result is implied.
