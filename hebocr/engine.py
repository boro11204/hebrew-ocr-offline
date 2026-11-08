
"""hebocr.engine — offline Hebrew OCR for square and Rashi script (no AI at runtime).

Uses the Tesseract LSTM engine with two fine-tuned models from this repo, page layout
helpers, per-line script selection and a word-frequency spelling corrector.
"""
import os, re, subprocess, tempfile, shutil, json
import numpy as np
from PIL import Image, ImageOps
HERE=os.path.dirname(os.path.abspath(__file__))
ROOT=os.path.dirname(HERE)
MODELS=os.environ.get('HEBOCR_MODELS', os.path.join(ROOT,'models'))
LMDIR=os.environ.get('HEBOCR_LM', os.path.join(ROOT,'lm'))
RASHI='heb_rashi4'; SQUARE='heb4'
PICK_W=float(os.environ.get('HEBOCR_PICK_W','30'))
_HEB=re.compile(r'[\u05d0-\u05ea]')

def _tessdata_dir():
    # tesseract needs configs/ next to the models; build a temp dir with links if missing
    if os.path.isdir(os.path.join(MODELS,'configs')): return MODELS
    import hashlib
    d=os.path.join(tempfile.gettempdir(),'hebocr_tessdata_'+hashlib.md5(os.path.abspath(MODELS).encode()).hexdigest()[:8]); os.makedirs(d,exist_ok=True)
    for f in os.listdir(MODELS):
        if f.endswith('.traineddata') and not os.path.exists(os.path.join(d,f)):
            try: os.symlink(os.path.join(MODELS,f), os.path.join(d,f))
            except OSError: shutil.copy(os.path.join(MODELS,f), os.path.join(d,f))
    if not os.path.exists(os.path.join(d,'configs')):
        for cand in ['/usr/share/tesseract-ocr/5/tessdata','/usr/share/tesseract-ocr/4.00/tessdata','/usr/share/tessdata','/usr/local/share/tessdata','/opt/homebrew/share/tessdata']:
            if os.path.isdir(os.path.join(cand,'configs')):
                for sub in ('configs','tessconfigs'):
                    if os.path.isdir(os.path.join(cand,sub)) and not os.path.exists(os.path.join(d,sub)):
                        try: os.symlink(os.path.join(cand,sub), os.path.join(d,sub))
                        except OSError: shutil.copytree(os.path.join(cand,sub), os.path.join(d,sub))
                break
        if not os.path.exists(os.path.join(d,'configs')):
            os.makedirs(os.path.join(d,'configs'),exist_ok=True)
            open(os.path.join(d,'configs','tsv'),'w').write('tessedit_create_tsv 1\n')
    return d

def load_pages(path, dpi=300, pages=None):
    """Return list of PIL grayscale images from an image file or a PDF."""
    if path.lower().endswith('.pdf'):
        try:
            import fitz
        except ImportError:
            import pymupdf as fitz
        doc=fitz.open(path); out=[]
        rng=pages or range(1,len(doc)+1)
        for p in rng:
            pix=doc[p-1].get_pixmap(dpi=dpi, colorspace=fitz.csGRAY)
            out.append(Image.frombytes('L',(pix.width,pix.height),pix.samples))
        return out
    im=Image.open(path); im=ImageOps.exif_transpose(im)
    return [im.convert('L')]

def _otsu(a):
    h=np.bincount(a.ravel(),minlength=256).astype(float); p=h/h.sum(); om=np.cumsum(p); mu=np.cumsum(p*np.arange(256))
    sb=(mu[-1]*om-mu)**2/(om*(1-om)+1e-12); return int(np.argmax(sb))

def glyph_height(gray):
    """median height of letter-sized connected components"""
    import cv2
    a=np.asarray(gray); ink=(a<_otsu(a)).astype(np.uint8)
    n,lab,st,_=cv2.connectedComponentsWithStats(ink,8)
    h=st[1:,cv2.CC_STAT_HEIGHT]; w=st[1:,cv2.CC_STAT_WIDTH]
    keep=(h>4)&(h<300)&(w>2)&(w<300)
    return float(np.median(h[keep])) if keep.any() else 20.0

def normalize_scale(gray, target=20.0, lo=12.0, hi=1e9):
    """resize so the median letter is about `target` px tall (only when far off)"""
    gh=glyph_height(gray); s=1.0
    if gh<lo or gh>hi: s=target/gh
    if abs(s-1)<0.05: return gray,1.0
    return gray.resize((max(1,int(gray.width*s)),max(1,int(gray.height*s))), Image.LANCZOS), s

def deskew(gray, max_angle=4.0):
    import cv2
    a=np.asarray(gray); ink=(a<_otsu(a)).astype(np.uint8)
    small=cv2.resize(ink,(ink.shape[1]//2,ink.shape[0]//2),interpolation=cv2.INTER_AREA)
    best=(0,0.0)
    for ang in np.arange(-max_angle,max_angle+0.01,0.25):
        M=cv2.getRotationMatrix2D((small.shape[1]/2,small.shape[0]/2),ang,1.0)
        r=cv2.warpAffine(small,M,(small.shape[1],small.shape[0]))
        v=np.var(r.sum(1).astype(float))
        if v>best[0]: best=(v,ang)
    M0=cv2.getRotationMatrix2D((small.shape[1]/2,small.shape[0]/2),0,1.0)
    v0=np.var(small.sum(1).astype(float))
    if abs(best[1])<0.75 or best[0]<v0*1.05: return gray,0.0
    return gray.rotate(best[1],resample=Image.BICUBIC,fillcolor=255,expand=False), best[1]

def split_columns(gray, max_cols=2, min_gap_frac=0.004, with_x=False):
    """Split a page into side-by-side columns at the clearest vertical gutter(s), read right to left.
    Long vertical rules between columns are ignored."""
    import cv2
    a=np.asarray(gray); h,w=a.shape; ink=(a<_otsu(a)).astype(np.uint8)
    rules=cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((max(25,h//12),1),np.uint8))
    ink=ink & (1-rules)
    cp=ink[int(h*.08):int(h*.92)].sum(0).astype(float); sm=np.convolve(cp,np.ones(15)/15,'same')
    med=np.median(sm[int(w*.1):int(w*.9)])+1e-6
    cuts=[]
    if max_cols>=2:
        lo,hi=int(w*.3),int(w*.7); x=lo+int(np.argmin(sm[lo:hi]))
        if sm[x] < 0.25*med:
            # widen to the valley edges and cut in its middle
            l=x; r=x
            while l>lo and sm[l-1]<0.25*med: l-=1
            while r<hi and sm[r+1]<0.25*med: r+=1
            if r-l+1>=max(3,int(w*min_gap_frac)): cuts.append((l+r)//2)
    xs=[0]+cuts+[w]
    cols=[(xs[k],xs[k+1]) for k in range(len(xs)-1)]
    if with_x: return [(gray.crop((x0,0,x1,h)),x0) for x0,x1 in cols[::-1]]
    return [gray.crop((x0,0,x1,h)) for x0,x1 in cols[::-1]]

def tesseract_lines(gray, lang, psm=3, extra=()):
    td=_tessdata_dir()
    with tempfile.NamedTemporaryFile(suffix='.png',delete=False) as f: p=f.name
    gray.save(p)
    try:
        env=dict(os.environ); env.setdefault('OMP_THREAD_LIMIT','1')
        r=subprocess.run(['tesseract',p,'-','--tessdata-dir',td,'-l',lang,'--psm',str(psm),*extra,'tsv'],capture_output=True,text=True,env=env,timeout=600)
    finally: os.remove(p)
    L={}; order=[]
    for row in r.stdout.split('\n')[1:]:
        f=row.split('\t')
        if len(f)<12: continue
        key=(int(f[1]),int(f[2]),int(f[3]),int(f[4]))
        if f[0]=='4': L[key]={'box':[int(f[6]),int(f[7]),int(f[6])+int(f[8]),int(f[7])+int(f[9])],'words':[],'conf':[]}; order.append(key)
        elif f[0]=='5' and f[11].strip() and key in L:
            L[key]['words'].append(f[11]); L[key]['conf'].append(float(f[10]))
    return [dict(box=L[k]['box'],text=' '.join(L[k]['words']),words=L[k]['words'],conf=L[k]['conf'],block=k[:2]) for k in order if L[k]['words']]

_LM=None; _CORR=None
def get_corrector():
    global _CORR
    if _CORR is None:
        from .corrector import Corrector
        _CORR=Corrector(LMDIR, os.path.join(LMDIR,'confusion_rashi.json'), margin=2.0, inv_mult=3.0, sub_cost=3.0)
    return _CORR

def vocab_ratio(text):
    c=get_corrector(); ws=[w for w in re.findall(r'[\u05d0-\u05ea]+(?:[״"׳\'][\u05d0-\u05ea]+)*',text) if len(w)>=2]
    if not ws: return 0.0
    return sum(1 for w in ws if w.replace('"','״') in c.lm.u)/len(ws)

def _overlap(a,b):
    x0=max(a[0],b[0]); y0=max(a[1],b[1]); x1=min(a[2],b[2]); y1=min(a[3],b[3])
    if x1<=x0 or y1<=y0: return 0.0
    inter=(x1-x0)*(y1-y0); return inter/min((a[2]-a[0])*(a[3]-a[1]),(b[2]-b[0])*(b[3]-b[1]))

def pick_lines(A, B, la, lb):
    """per line, choose the reading from model A or B (same layout)."""
    out=[]; used=set()
    for x in A:
        best=None
        for j,y in enumerate(B):
            if j in used: continue
            if _overlap(x['box'],y['box'])>0.6: best=j; break
        cands=[(x,la)] + ([(B[best],lb)] if best is not None else [])
        if best is not None: used.add(best)
        def score(c):
            l=c[0]; return vocab_ratio(l['text'])*PICK_W + (np.mean(l['conf']) if l['conf'] else 0)
        ch=max(cands,key=score); out.append(dict(ch[0],model=ch[1]))
    for j,y in enumerate(B):
        if j not in used and not any(_overlap(y['box'],o['box'])>0.3 for o in out): out.append(dict(y,model=lb))
    out.sort(key=lambda l:(l['block'],l['box'][1]))
    return out

def ocr_page(gray, script='auto', layout='auto', correct=True, prep=True):
    """OCR one page image. script: auto|rashi|square. layout: auto|columns|block|line."""
    info={'steps':[]}
    if prep:
        gray,s=normalize_scale(gray); info['scale']=s
        gray,ang=deskew(gray); info['deskew']=ang
    if layout=='columns': parts=split_columns(gray, with_x=True)
    else: parts=[(gray,0)]
    info['size']=list(gray.size)
    psm={'auto':3,'columns':4,'block':6,'line':7}.get(layout,3)
    all_lines=[]
    for pi,(part,x0) in enumerate(parts):
        if script=='rashi': lines=[dict(l,model=RASHI) for l in tesseract_lines(part,RASHI,psm)]
        elif script=='square': lines=[dict(l,model=SQUARE) for l in tesseract_lines(part,SQUARE,psm)]
        else:
            A=tesseract_lines(part,RASHI,psm); B=tesseract_lines(part,SQUARE,psm)
            lines=pick_lines(A,B,RASHI,SQUARE)
        for l in lines:
            l['part']=pi
            if l.get('box'): l['box']=[l['box'][0]+x0,l['box'][1],l['box'][2]+x0,l['box'][3]]
        all_lines+=lines
    if correct:
        c=get_corrector()
        for l in all_lines:
            new,ch=c.correct_line(l['text'], None)
            l['raw']=l['text']; l['text']=new; l['fixes']=ch
    return dict(lines=all_lines, text='\n'.join(l['text'] for l in all_lines), info=info)

def ocr_file(path, script='auto', layout='auto', correct=True, pages=None, dpi=300):
    res=[]
    for im in load_pages(path, dpi=dpi, pages=pages):
        res.append(ocr_page(im, script=script, layout=layout, correct=correct))
    return res


def prepared_image(gray, info):
    """re-create the exact image the line boxes refer to (after scaling and deskew), for crops"""
    s=info.get('scale',1.0)
    if s!=1.0: gray=gray.resize((max(1,int(gray.width*s)),max(1,int(gray.height*s))), Image.LANCZOS)
    ang=info.get('deskew',0.0)
    if ang: gray=gray.rotate(ang,resample=Image.BICUBIC,fillcolor=255,expand=False)
    return gray
