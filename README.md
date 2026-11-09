# hebrew-ocr-offline

Free, offline Hebrew OCR for printed seforim, in **square script and Rashi script**, plus a **proofreading tool** that compares a typed text with the original scan. No AI, no API key, no internet needed once installed. It runs on your own computer.

It also powers the "Engine" mode of the Hebrew OCR website: https://hebrew-ocr.sites.tab.bot (also at https://boro11204.github.io/hebrew-ocr/).

## What is in here

| Folder | What it is |
|---|---|
| `models/heb_rashi4.traineddata` | Tesseract model for **Rashi script**, fine-tuned on about 7,900 real printed lines |
| `models/heb4.traineddata` | Tesseract model for **square script** (Gemara, sefarim), fine-tuned on real printed lines |
| `lm/` | word and word-pair counts from 8.5 million words of Sefaria's open Hebrew texts (spelling fixes and "is this a real word" checks) |
| `hebocr/` | the Python program: `engine.py` (OCR), `proofread.py` (compare), `corrector.py` (optional spelling fix) |
| `training/` | the scripts used to build the training lines and train the models, for anyone who wants to train more |

The two model files are added to the repo by a small GitHub Action (`.github/workflows/fetch-models.yml`). It copies them from the website and checks their SHA-256, because they are too big for the uploader we used. If `models/` is empty right after you clone, wait a minute and pull again, or download them yourself (see "Install").

## Install

You need Python 3.9 or newer and Tesseract 5.

```
# Ubuntu / Debian
sudo apt-get install tesseract-ocr
# macOS
brew install tesseract
# Windows: install Tesseract from https://github.com/UB-Mannheim/tesseract/wiki

pip install -r requirements.txt
```

If the model files are missing:

```
curl -L -o models/heb_rashi4.traineddata https://hebrew-ocr.sites.tab.bot/tessdata/heb_rashi4.traineddata
curl -L -o models/heb4.traineddata https://hebrew-ocr.sites.tab.bot/tessdata/heb4.traineddata
```

## Use it

Run these from this folder.

**Read a scan into text**

```
python3 -m hebocr ocr page.jpg --script rashi --out page.txt
python3 -m hebocr ocr book.pdf --pages 1-10 --script square --layout columns --out book.txt
```

- `--script`: `rashi`, `square`, or `auto` (tries both, line by line).
- `--layout`: `columns` for two-column pages, `block` for one column, `auto` to let Tesseract decide.
- `--correct`: turns on the word-list spelling fix. It helps a little on square script and does about nothing on Rashi, so it is off by default.

**Proofread a typed text against the scan**

```
python3 -m hebocr proofread typed.docx scan.pdf --pages 15-30 --out report
```

The typed file can be `.txt`, `.docx` or `.pdf`. This writes:

- `report.html`: the typed text with colors. Click a mark to see the scan line it came from.
  - Yellow = changed word, more sure.
  - Orange = changed word, worth checking.
  - Red crossed out = typed words that are not in the scan.
  - **[חסר: …]** = words in the scan that are missing from the typed text.
- `report.docx`: the same marks in Word.
- `report.json`: every flag with its confidence (0 to 1).

How it works:

1. It reads each scan page 3 times at different sizes (`--passes`). The readings vote.
2. It finds where the page sits in the typed text.
3. It lines up the words, while understanding abbreviations (כמ״ש = כמו שכתב, ביהכ״פ = ביום הכיפורים, וכו׳ = וכולי), spelling with or without ו/י, and words split or joined.
4. It ignores punctuation, (sources in round brackets), [editor additions in square brackets] and editor headings.
5. Each difference gets a confidence score built from:
   - how many readings agree;
   - Tesseract's own confidence;
   - whether the scan word is a real word;
   - whether the change looks like a typical OCR mix-up **for this scan** (it learns the scan's habits from the document itself);
   - whether the text was only moved somewhere else.

Use `--sure` and `--check` to change how many flags you see.

## How good is it? (honest numbers)

Every test below used pages that were never used in training. "Wrong letters" is the character error rate: lower is better.

**OCR: Vilna Shas, Rosh Hashana 2a (answer key checked by hand)**

| Test | Before (stock models) | After (these models) |
|---|---|---|
| Rashi column crop, website Engine mode | 32.1% | **16.4%** |
| Square Gemara crop, website Engine mode | 5.8% | **4.1%** |
| Rashi column crop, command line, the training worker's own crop | 23.5% | **9.3%** |
| Square crop, command line | 6.2% | **3.9%** |
| Full Berakhot page (layout + OCR), Rashi part | 45% | **17%** |
| Full Berakhot page, Tosafot part | 14% | **8%** |

The site numbers above were measured with the same test script before and after. The site's earlier report of "Rashi 20%, square 4.3%" came from its own test settings, so it is not directly comparable. On the small low-resolution Rashi crop used by the site, the command line gets about 18%.

For comparison, a good AI reader (Gemini) gets about 1–2% on the same Rashi crop. **Offline OCR on Rashi script is much better than before, but still far behind AI.**

**Proofreading:**

- Typed: Teshuvah MeAhavah vol. 2, Mechon Netzach Yakov edition. Scan: Prague 1815 printing.
- Ten held-out pages, compared with an earlier careful AI proofread of the same pages: 66 marks on those pages.
- The scoring was tuned on 5 of the pages (15, 35, 55, 75, 95) and tested on the other 5 (25, 45, 65, 85, 105):

| Test pages | Flags per page | Share of flags that the AI proofread also marked (precision) | Share of the AI's marks it found (recall) |
|---|---|---|---|
| "to check" level (orange + yellow) | about 18 | 12% | 38% |
| "sure" level (yellow only) | about 4 | 18% | 15% |

Why it is weak on this book: the offline OCR reads only about 74% of the words on this 1815 Rashi-script print exactly right. Many of its flags are reading mistakes, not typing mistakes. Some flags may be real differences that the AI proofread missed; we did not check those by hand.

**Bottom line:**

- On clean square-script print, the proofreader is a useful first pass.
- On old Rashi script, treat it as a rough helper and always look at the scan picture next to each flag.
- It does not replace a human or AI proofreader.

## Licenses and credits

- **Code** in this repo: Apache License 2.0 (see `LICENSE`).
- **models/heb_rashi4.traineddata**:
  - Fine-tuned from **heb_rashi** by **Zeev Pekar / pninim.org** (https://gitlab.com/pninim.org/tessdata_heb_rashi), Copyright 2021 Zeev Pekar, Apache License 2.0.
  - Changed by further training (Nov 2026).
- **models/heb4.traineddata**:
  - Fine-tuned from Google's **tessdata_best** `heb` (https://github.com/tesseract-ocr/tessdata_best), Apache License 2.0.
  - Changed by further training (Nov 2026).
- **Training images** were cut from public-domain scans:
  - the Vilna Shas, Romm edition reprint of 1925, from the Internet Archive (archive.org);
  - *Teshuvah MeAhavah*, Prague 1815.
- **Training labels and the `lm/` word counts** come from texts on **Sefaria** (https://www.sefaria.org):
  - Talmud Bavli, Rashi and Tosafot, mostly the Vilna / Wikisource Hebrew versions;
  - more open rabbinic texts.
  - The classic texts are public domain. Each Sefaria version has its own license (public domain or Creative Commons, for example CC-BY-SA for Wikisource texts), listed on its page on Sefaria.
  - `lm/` holds only word counts made from those texts.
- **Tesseract OCR** (https://github.com/tesseract-ocr/tesseract), Apache License 2.0. It is used as a program and is not included here.
- **Python libraries:** Pillow, NumPy, OpenCV, RapidFuzz, PyMuPDF and python-docx. Each has its own license.

## Train more

`training/` holds the scripts that were used. They are written for the machine they ran on, so you will need to change the paths:

- `mk_vilna.py` / `mk_prague.py`: cut line images from scans and match each line to its known text.
- `gen_lstmf.py`, `train.sh`: Tesseract `lstmtraining` fine-tuning (about 8,000–11,000 iterations).
- `build_lm.py`: build the word counts.
- `harness.py`: the error-rate measure used for every number above.


## v5 (Nov 9, 2026): worn-print Rashi model + Sefaria word model
- `models/heb_rashi5.traineddata` (added by the fetch workflow): hr3 fine-tuned 35,000 more iterations on ~16.7k real Prague 1815 and Vilna Rashi lines, each also in 2 artificially worn copies (`training/aug2_worn.py`: about 20 kinds of wear — ink bleed, broken strokes, erosion/dilation, blur, noise, uneven light, foxing, stains with tide lines, bleed-through, scratches, press slur, skew, warp and more). Test pages were kept out.
- `lm/sefaria_lm_words.txt`, `lm/sefaria_lm_bigrams.txt`: word and word-pair counts from public Sefaria texts (Rosh Hashana and Berakhot left out), used to re-score look-alike letters after OCR. No source text is looked up.
- Rosh Hashana 2a test crops, browser engine: Rashi 16.4% → 14.6% wrong letters, square 4.1% → 2.8%.
