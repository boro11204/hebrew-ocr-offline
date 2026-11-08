
import re, unicodedata
from rapidfuzz.distance import Levenshtein as RL
SOF={'ך':'כ','ם':'מ','ן':'נ','ף':'פ','ץ':'צ'}
def norm(t, strip_parens=False, fold_sofit=False):
    t=re.sub(r'\[\[[^\]]*\]\]','',t); t=t.replace('[?]','').replace('[…]','')
    if strip_parens: t=re.sub(r'\([^)]*\)','',t)
    t=unicodedata.normalize('NFD',t)
    t=''.join(ch for ch in t if not ('\u0591'<=ch<='\u05C7' and ch not in '\u05BE\u05C3'))
    t=re.sub(r'[^\u05D0-\u05EA\s]',' ',t)
    if fold_sofit: t=''.join(SOF.get(c,c) for c in t)
    return re.sub(r'\s+',' ',t).strip()
def norm2(t): return ' '.join(w for w in norm(t).split() if len(w)>1)
def cer(ocr, gt_raw):
    g=norm2(gt_raw); o=norm2(ocr); return RL.distance(o,g)/max(1,len(g))
def wer(ocr, gt_raw):
    g=norm2(gt_raw).split(); o=norm2(ocr).split(); return RL.distance(o,g)/max(1,len(g))
