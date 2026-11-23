Model files. heb_rashi7.traineddata is the default Rashi model (heb_rashi6, heb_rashi5 and heb_rashi4 stay selectable with --rashi-model or HEBOCR_RASHI); heb4.traineddata is the square-script model. The bigger files are added by the GitHub Actions in .github/workflows/ (fetch-models*.yml, each SHA-256 checked). See the main README for licenses.

`vilna_rashi_trial.traineddata` is an optional Vilna Rashi model for the command line. It derives from `heb_rashi7` and ultimately from the Apache-2.0 `heb_rashi` model by Zeev Pekar / pninim.org, copyright 2021. In November 2026 it was fine-tuned for 300 iterations on 229 Rashi line images from Berakhot 3a–6b, using E-Daf scans and labels aligned with Sefaria's Vilna Edition. Its SHA-256 is `5e70d1f0001d3f308e9f22af6eb9f7f2eb9af784584e5638ac43558aa65dd2bd`.

On four hand-checked passages from Berakhot 8a–8b, native Tesseract in block mode (PSM 6) made 25 Hebrew-letter errors in 554 letters with `heb_rashi7` and 12 with the trial model. The four passage counts went from 12 to 6, 7 to 6, 6 to 0, and 0 to 0. These pages were held out of the edition fine-tuning. The original model's complete training-page inventory is unavailable. This small test covers one printed edition.

```sh
python3 -m hebocr ocr rashi-column.png --script rashi --layout block --rashi-model vilna_rashi_trial
```
