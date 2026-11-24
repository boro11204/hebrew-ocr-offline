"""Fine-tune Tesseract on corrected Hebrew line images from one printed edition."""
import argparse
import hashlib
import os
import random
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image
from rapidfuzz.distance import Levenshtein


def run(*args):
    result = subprocess.run([str(a) for a in args], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or f"{args[0]} exited {result.returncode}")
    return result


def letters(text):
    return "".join(c for c in text if "א" <= c <= "ת")


def load_samples(root):
    splits = {}
    seen_pages, seen_images = set(), set()
    for split in ("train", "validation", "test"):
        rows = []
        pages = set()
        for img in sorted((root / split).glob("*/*.png")):
            page = img.parent.name
            if page in seen_pages:
                raise ValueError(f"Page {page} occurs in multiple splits")
            label = img.with_suffix(".gt.txt").read_text(encoding="utf-8-sig").strip()
            if len(label.splitlines()) != 1 or not letters(label):
                raise ValueError(f"Expected one transcribed Hebrew line for {img}")
            with Image.open(img) as im:
                gray = im.convert("L")
                digest = hashlib.sha256(str(gray.size).encode() + gray.tobytes()).digest()
            if digest in seen_images:
                raise ValueError(f"Repeated image in dataset: {img}")
            seen_images.add(digest)
            pages.add(page)
            rows.append((img.resolve(), label))
        if not rows:
            raise ValueError(f"Missing {split}/PAGE/*.png and matching .gt.txt files")
        seen_pages.update(pages)
        splits[split] = rows
    return splits


def score(rows, data_dir, model):
    errors = count = 0
    for path, ref in rows:
        result = run("tesseract", path, "stdout", "--tessdata-dir", data_dir,
                     "-l", model, "--psm", "7")
        expected = letters(ref)
        errors += Levenshtein.distance(expected, letters(result.stdout))
        count += len(expected)
    return errors, count


def fit(args, work):
    splits = load_samples(args.data)
    data = work / "models"
    data.mkdir()
    base = data / "starter.traineddata"
    shutil.copyfile(args.base, base)
    lstm = work / "starter.lstm"
    run("combine_tessdata", "-e", base, lstm)
    samples = []
    for idx, (img, label) in enumerate(splits["train"]):
        stem = work / f"line_{idx:06d}"
        with Image.open(img) as im:
            width, height = im.size
        # Use the same visual-order Hebrew line boxes as the upstream training scripts.
        box = "".join(f"{ch} 0 0 {width} {height} 0\n" for ch in label[::-1])
        stem.with_suffix(".box").write_text(box + f"\t 0 0 {width} {height} 0\n", encoding="utf-8")
        local_image = stem.with_suffix(".png")
        shutil.copyfile(img, local_image)
        run("tesseract", local_image, stem, "--tessdata-dir", data, "-l", "starter",
            "--psm", "13", "-c", "tessedit_train_line_recognizer=1")
        sample = stem.with_suffix(".lstmf")
        if not sample.is_file() or not sample.stat().st_size:
            raise RuntimeError(f"Tesseract produced no training sample for {img}")
        samples.append(str(sample))
    random.Random(43).shuffle(samples)
    manifest = work / "train.txt"
    manifest.write_text("\n".join(samples) + "\n", encoding="utf-8")
    prefix = work / "edition"
    run("lstmtraining", "--continue_from", lstm, "--traineddata", base,
        "--model_output", prefix, "--train_listfile", manifest, "--max_iterations",
        args.iterations, "--learning_rate", args.rate, "--reset_learning_rate",
        "--target_error_rate", "0")
    candidate = data / "candidate.traineddata"
    run("lstmtraining", "--stop_training", "--continue_from", str(prefix) + "_checkpoint",
        "--traineddata", base, "--model_output", candidate)
    improved = True
    for name in ("validation", "test"):
        before, total = score(splits[name], data, "starter")
        after, _ = score(splits[name], data, "candidate")
        print(f"{name}: {before}/{total} -> {after}/{total} Hebrew letter errors", flush=True)
        improved = improved and after < before
    if not improved:
        print("Kept the starter. A new edition model needs fewer errors on both splits.")
        return
    # Link the finished file into place atomically without overwriting another run.
    os.link(candidate, args.output)
    print(f"Saved {args.output}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--iterations", type=int, default=500)
    parser.add_argument("--rate", type=float, default=0.0001)
    args = parser.parse_args()
    if args.iterations < 1 or not 0 < args.rate <= 1:
        parser.error("Specify positive iterations and a learning rate in (0, 1].")
    if args.output.suffix != ".traineddata" or args.output.exists():
        parser.error("Choose a new .traineddata output path.")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("OMP_THREAD_LIMIT", "1")
    with tempfile.TemporaryDirectory(dir=args.output.parent) as temp:
        fit(args, Path(temp).resolve())


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        sys.exit(str(error))
