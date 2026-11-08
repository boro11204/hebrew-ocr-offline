"""hebocr.proofread: compare a typed text against an original scan, with no AI.

Steps: OCR the scan (several independent readings) -> find where each scan page sits in the typed
text -> align word by word (anchors on unique 3-word runs, then a dynamic alignment that knows
abbreviations: כמ״ש = כמו שכתב, ביהכ״פ = ביום הכיפורים) -> each difference becomes a flag
(changed / missing / extra) -> a confidence for each flag from: how many OCR readings agree,
OCR word confidence, whether the scan word is a real word, whether the change is a typical OCR
letter mix-up for THIS scan (learned from the document itself), whether the text was only moved,
page edges and layout labels -> color-coded HTML (with the scan line picture for every flag) + DOCX.
"""

import re, os, json, bisect, html, math
from collections import defaultdict
from rapidfuzz.distance import Levenshtein as RL

FIN={'ך':'כ','ם':'מ','ן':'נ','ף':'פ','ץ':'צ'}
WORD_RE=re.compile(r'\S+')
def norm_word(w):
    """letters only, final letters unified; abbreviation marks dropped"""
    w=re.sub(r'[\u0591-\u05C7]','',w)
    w=re.sub(r'[^\u05d0-\u05ea]','',w)
    return ''.join(FIN.get(c,c) for c in w)
def is_abbrev(w): return bool(re.search(r'[״"׳\']',w))

# ---------- loading typed text ----------
def _fix_legacy(s):
    """Hebrew PDFs from old DOS/Windows fonts often extract as Latin-1 garbage (cp1255 bytes)."""
    heb=len(re.findall(r'[\u05d0-\u05ea]',s)); lat=len(re.findall(r'[\u00c0-\u00ff]',s))
    if heb>lat or lat<50: return s
    out=[]
    for ch in s:
        o=ord(ch)
        if 0xE0<=o<=0xFA: out.append(chr(0x05D0+o-0xE0))
        else: out.append(ch)
    return ''.join(out)
def load_typed(path):
    p=path.lower()
    if p.endswith('.txt') or p.endswith('.md'): t=open(path,encoding='utf-8',errors='replace').read()
    elif p.endswith('.docx'):
        import docx; t='\n'.join(par.text for par in docx.Document(path).paragraphs)
    elif p.endswith('.pdf'):
        try: import fitz
        except ImportError: import pymupdf as fitz
        d=fitz.open(path); t='\n'.join(pg.get_text() for pg in d)
    else: raise ValueError('typed file must be .txt, .docx or .pdf')
    return _fix_legacy(t)

def tokenize_typed(text, ignore_brackets=True):
    """tokens with original string, normalized form and char offsets.
    Words inside [square brackets] (editor-added sources) are kept for alignment but never flagged."""
    toks=[]; depth=0
    for m in WORD_RE.finditer(text):
        w=m.group(0)
        opens=w.count('['); closes=w.count(']')
        inside = depth>0 or opens>0
        depth=max(0,depth+opens-closes)
        n=norm_word(w)
        if n: toks.append(dict(t=w,n=n,s=m.start(),e=m.end(),ab=is_abbrev(w),src=bool(ignore_brackets and inside)))
    return toks

def ocr_tokens(pages):
    """pages: list of engine results; returns OCR word tokens with page/line/conf"""
    toks=[]
    for pi,pg in enumerate(pages):
        for li,l in enumerate(pg['lines']):
            ws=l.get('words') or l['text'].split(); cs=l.get('conf') or [50]*len(ws)
            fixed=l['text'].split() if len(l['text'].split())==len(ws) else ws
            for k,w in enumerate(ws):
                n=norm_word(w)
                if not n: continue
                fw=fixed[k] if k<len(fixed) else w
                toks.append(dict(t=fw,raw=w,n=norm_word(fw) or n,c=cs[k] if k<len(cs) else 50,page=pi,line=li,part=l.get('part',0),box=l.get('box'),ab=is_abbrev(w)))
    return toks


# ---------- alignment ----------
def _lis(pairs):
    pairs=sorted(pairs); tails=[]; ti=[]; prev=[-1]*len(pairs)
    for k,(o,t) in enumerate(pairs):
        pos=bisect.bisect_left(tails,t)
        if pos==len(tails): tails.append(t); ti.append(k)
        else: tails[pos]=t; ti[pos]=k
        prev[k]=ti[pos-1] if pos>0 else -1
    k=ti[-1] if ti else -1; out=[]
    while k!=-1: out.append(pairs[k]); k=prev[k]
    return out[::-1]

def anchors(O, T, n=3, window=None):
    """unique word n-grams shared by OCR and typed text, kept in a consistent order (LIS)"""
    lo,hi=(0,len(T)) if window is None else window
    idx=defaultdict(list)
    for j in range(lo,max(lo,hi-n+1)): idx[tuple(T[x]['n'] for x in range(j,j+n))].append(j)
    pairs=[]
    for i in range(len(O)-n+1):
        js=idx.get(tuple(o['n'] for o in O[i:i+n]))
        if js and len(js)==1: pairs+=[(i+k,js[0]+k) for k in range(n)]
    chain=_lis(sorted(set(pairs)))
    good=[]
    for k,(i,j) in enumerate(chain):
        nb=[c for c in chain[max(0,k-3):k+4] if c!=(i,j)]
        if not nb or any(abs((j-jj)-(i-ii))<=15 for ii,jj in nb): good.append((i,j))
    return good

def page_window(O, T, n=4):
    """find where this scan page sits in the typed text (densest cluster of shared 4-grams)"""
    idx=defaultdict(list)
    for j in range(len(T)-n+1): idx[tuple(T[x]['n'] for x in range(j,j+n))].append(j)
    hits=[]
    for i in range(len(O)-n+1):
        js=idx.get(tuple(o['n'] for o in O[i:i+n]))
        if js and len(js)<=3: hits+=[j-i for j in js]
    if not hits: return None
    hits.sort(); best=(0,0); L=len(O)
    k=0
    for a in range(len(hits)):
        while hits[a]-hits[k]>L*0.5: k+=1
        if a-k+1>best[0]: best=(a-k+1,hits[(a+k)//2])
    off=best[1]
    return (max(0,off-int(0.3*L)-50), min(len(T),off+int(1.3*L)+50))

PREF='ובדהכלמש'
def abbr_expands(a, ws):
    """abbreviation letters a (e.g. 'כמש') spell the starts of words ws (e.g. ['כמו','שכתב'])"""
    k=len(ws)
    if k==0 or len(a)<k: return False
    memo={}
    def rec(pos,i):
        if i==k: return pos==len(a)
        key=(pos,i)
        if key in memo: return memo[key]
        ok=False
        for e in range(pos+1, len(a)-(k-i-1)+1):
            if ws[i].startswith(a[pos:e]) and rec(e,i+1): ok=True; break
        memo[key]=ok; return ok
    return rec(0,0)

def equiv1(o,t):
    """same word for proofreading purposes (spelling variants, abbreviation styles)"""
    a,b=o['n'],t['n']
    if a==b: return 0.0
    if plene(a,b): return 0.05
    if (o['ab'] or t['ab']) and min(len(a),len(b))>=2 and (a.startswith(b) or b.startswith(a)): return 0.05
    if (o['ab'] or t['ab']) and len(a)>=2 and len(b)>=2 and a[0] in 'הו' and a[1:]==b: return 0.1
    if (o['ab'] or t['ab']) and len(a)>=2 and len(b)>=2 and b[0] in 'הו' and b[1:]==a: return 0.1
    return None

def wsub_cost(a,b):
    if a==b: return 0.0
    d=RL.distance(a,b)/max(len(a),len(b)); return min(1.6, 0.2+1.4*d)

def dp_align(O, T, oi0=0, tj0=0):
    """word alignment of an OCR run and a typed run that understands abbreviations:
    returns ops (kind, [o idx], [t idx]) with kind eq/sub/del/ins"""
    n,m=len(O),len(T)
    if n*m>400000:
        return [('del',[oi0+i],[]) for i in range(n)]+[('ins',[],[tj0+j]) for j in range(m)]
    INF=1e9
    D=[[INF]*(m+1) for _ in range(n+1)]; B=[[None]*(m+1) for _ in range(n+1)]
    D[0][0]=0.0
    for i in range(n+1):
        for j in range(m+1):
            d=D[i][j]
            if d>=INF: continue
            # typed word inside editor sources costs nothing to skip
            if j<m:
                c=0.01 if T[j].get('src') else 1.0
                if d+c<D[i][j+1]: D[i][j+1]=d+c; B[i][j+1]=('ins',1,0 if c>0.5 else 1)
            if i<n:
                if d+1.0<D[i+1][j]: D[i+1][j]=d+1.0; B[i+1][j]=('del',1,0)
            if i<n and j<m:
                e=equiv1(O[i],T[j])
                if e is not None: c=e; tag='eq'
                else: c=wsub_cost(O[i]['n'],T[j]['n']); tag='sub'
                if d+c<D[i+1][j+1]: D[i+1][j+1]=d+c; B[i+1][j+1]=(tag,1,1)
                # one OCR abbreviation = several typed words, or the reverse; also split/joined words
                for k in range(2,5):
                    if j+k<=m:
                        ws=[T[x]['n'] for x in range(j,j+k)]
                        if (O[i]['ab'] and abbr_expands(O[i]['n'],ws)) or O[i]['n']==''.join(ws):
                            if d+0.05<D[i+1][j+k]: D[i+1][j+k]=d+0.05; B[i+1][j+k]=('eq',1,k)
                    if i+k<=n:
                        ws=[O[x]['n'] for x in range(i,i+k)]
                        if (T[j]['ab'] and abbr_expands(T[j]['n'],ws)) or T[j]['n']==''.join(ws):
                            if d+0.05<D[i+k][j+1]: D[i+k][j+1]=d+0.05; B[i+k][j+1]=('eq',k,1)
    i,j=n,m; ops=[]
    while i>0 or j>0:
        tag,di,dj=B[i][j]
        if tag=='ins':
            ops.append(('src' if dj==1 and T[j-1].get('src') and False else 'ins',[],[tj0+j-1]))
            i2,j2=i,j-1
        else:
            i2,j2=i-di,j-dj
            ops.append((tag,[oi0+x for x in range(i2,i)],[tj0+x for x in range(j2,j)]))
        i,j=i2,j2
    return ops[::-1]

def align(O, T, window=None):
    """full alignment: unique-n-gram anchors, then abbreviation-aware DP between anchors.
    returns ops and the typed span covered"""
    A=anchors(O,T,window=window)
    if not A: return [], (0,0)
    ops=[]; pi,pj=A[0][0]-1, A[0][1]-1
    for (i,j) in A:
        if i>pi+1 or j>pj+1:
            ops+=dp_align(O[pi+1:i], T[pj+1:j], pi+1, pj+1)
        ops.append(('eq',[i],[j])); pi,pj=i,j
    return ops, (A[0][1], A[-1][1])

def plene(a,b):
    """spelling differs only by an extra vav/yod inside the word (מלא/חסר), e.g. כוונה/כונה"""
    if a==b or abs(len(a)-len(b))>2 or min(len(a),len(b))<3: return False
    s,l=(a,b) if len(a)<len(b) else (b,a)
    ops=RL.editops(s,l)
    return all(op.tag=='insert' and l[op.dest_pos] in 'וי' and 0<op.dest_pos<len(l)-1 for op in ops)

def flags_from_ops(ops, O, T):
    """group consecutive non-equal ops into flags: changed / missing / extra"""
    flags=[]; k=0
    while k<len(ops):
        if ops[k][0]=='eq': k+=1; continue
        run=[]
        while k<len(ops) and ops[k][0]!='eq': run.append(ops[k]); k+=1
        oi=[x for op in run for x in op[1]]; tj=[x for op in run for x in op[2] if not T[x].get('src')]
        if not oi and not tj: continue
        nxt=next((op[2][0] for op in ops[k:] if op[2]),None)
        if oi and tj:
            ow=[O[x] for x in oi]; tw=[T[x] for x in tj]
            jo=''.join(w['n'] for w in ow); jt=''.join(w['n'] for w in tw)
            if jo==jt: continue
            flags.append(dict(kind='changed',oi=oi,tj=tj))
        elif oi: flags.append(dict(kind='missing',oi=oi,tj=[],at=nxt))
        else: flags.append(dict(kind='extra',oi=[],tj=tj))
    return flags

def pass_view(ops):
    """for one OCR pass: typed index -> 'eq' | 'diff' | 'gap'; and OCR-only words keyed by next typed index"""
    st={}; extra=defaultdict(list); pend=[]
    for kind,oi,tj in ops:
        if kind=='eq':
            for j in tj: st[j]='eq'
        elif kind=='sub':
            for j in tj: st[j]='diff'
        elif kind=='ins':
            for j in tj: st[j]='gap'
        if kind=='del': pend+=oi
        elif tj and pend:
            extra[tj[0]].append(pend); pend=[]
    return st, extra

CONF_PAIRS=set('דר רד דך ךד רך ךר הח חה הת תה חת תח וז זו וי יו ון ןו זן נז סם םס סמ מס סט טס בכ כב בפ כפ פכ טמ מט עצ צע נג גנ כנ נכ סש שס אח חא נב בנ ים מי ות תו'.split())
def explained_by_ocr(o,t):
    """True if every edit between OCR word o and typed word t is a typical OCR confusion"""
    ops=RL.editops(t,o)
    if not ops: return True
    if len(ops)>2: return False
    for op in ops:
        if op.tag=='replace':
            if t[op.src_pos]+o[op.dest_pos] not in CONF_PAIRS: return False
        elif op.tag=='delete':
            if t[op.src_pos] not in 'ויןר\'': return False
        else:
            if o[op.dest_pos] not in 'ויןר': return False
    return True

def _inv(words, vocab):
    if vocab is None or not words: return 0.5
    return sum(1 for w in words if w['n'] in vocab)/len(words)

def _near(a,b): return a==b or (len(a)>2 and RL.distance(a,b)<=1)

def compare_page(passes, T, vocab=None, window=None):
    """compare one scan page (one or more independent OCR passes of it) with the typed text.
    passes[0] is the main reading; the others only vote. Returns flags and the typed span."""
    O=passes[0]
    win=window or page_window(O,T)
    views=[align(Ok,T,window=win) for Ok in passes]
    ops0,span=views[0]
    if not ops0: return [], (0,0)
    flags=flags_from_ops(ops0,O,T)
    pvs=[(pass_view(v[0]),passes[k+1]) for k,v in enumerate(views[1:])]
    out=[]
    for f in flags:
        ow=[O[x] for x in f['oi']]; tw=[T[x] for x in f['tj']]
        if f['kind']=='extra' and (min(f['tj'])<=span[0]+1 or max(f['tj'])>=span[1]-1): continue
        sup=con=0
        for (st,extra),Ok in pvs:
            if f['kind']=='changed':
                if all(st.get(j)=='eq' for j in f['tj']): con+=1
                else:
                    # does this pass read the same "original" as the main pass?
                    sup+=1
            elif f['kind']=='extra':
                g=sum(1 for j in f['tj'] if st.get(j)=='gap')/len(f['tj'])
                if g>=0.5: sup+=1
                else: con+=1
            else:
                at=f.get('at')
                near=[]
                if at is not None:
                    for x in range(at-3,at+4):
                        for run in extra.get(x,[]): near+=[Ok[i]['n'] for i in run]
                on=[w['n'] for w in ow]
                hit=sum(1 for a in on if any(_near(a,b) for b in near))
                if on and hit>=0.5*len(on): sup+=1
                else: con+=1
        npass=sup+con
        agree=(sup/npass) if npass else 0.5
        c=(sum(w.get('c',80) for w in ow)/len(ow)/100.0) if ow else 0.85
        L=max(len(ow),len(tw))
        if f['kind']=='changed':
            o1=''.join(w['n'] for w in ow); t1=''.join(w['n'] for w in tw)
            expl=explained_by_ocr(o1,t1)
            dist=RL.distance(o1,t1)
            s=0.15+0.40*agree+0.15*c+0.20*_inv(ow,vocab)+0.10*(dist>=2)-0.30*expl-0.15*(len(o1)<=2)
            if len(ow)!=len(tw): s+=0.05
        elif f['kind']=='missing':
            short=(len(ow)==1 and len(ow[0]['n'])<=2)
            s=0.05+0.40*agree+0.15*c+0.25*_inv(ow,vocab)+min(0.25,0.06*L)-0.25*short
        else:
            short=(len(tw)==1 and len(tw[0]['n'])<=2)
            s=0.10+0.45*agree+0.20*_inv(tw,vocab)+min(0.25,0.07*L)-0.15*(len(tw)==1)-0.15*short
        f.update(typed=' '.join(w['t'] for w in tw), original=' '.join(w['t'] for w in ow),
                 j=(f['tj'][0] if f['tj'] else f.get('at')), conf=round(max(0.0,min(1.0,s)),2),
                 votes=f'{sup+1}/{npass+1}', page=(ow[0]['page'] if ow else None),
                 box=(ow[0].get('box') if ow else None), line=(ow[0].get('line') if ow else None))
        out.append(f)
    return out, span

def compare_pages(page_passes, T, vocab=None):
    """page_passes: list over scan pages; each item is a list of OCR token lists (passes) for that page"""
    flags=[]; spans=[]
    for p,passes in enumerate(page_passes):
        f,sp=compare_page(passes,T,vocab)
        for x in f:
            if x['page'] is None: x['page']=p
        flags+=f
        if sp!=(0,0): spans.append(sp)
    flags.sort(key=lambda f:(f['j'] if f['j'] is not None else 10**9))
    span=(min(s[0] for s in spans), max(s[1] for s in spans)) if spans else (0,0)
    return flags, span

LAYOUT_WORDS={'גליון','גליונ'}
_SUBS=defaultdict(int)   # learned OCR letter confusions for this document: (typed,ocr) -> count
STATIC_CONF=set('דר רד דכ כד רכ כר הח חה הת תה חת תח וז זו וי יו ונ נו זנ נז סמ מס סט טס בכ כב בפ פב כפ פכ טמ מט עצ צע עט טע נג גנ כנ נכ סש שס אח חא נב בנ ות תו אה הא לנ נל גכ כג'.split())
CONF_PAIRS=STATIC_CONF
def learn_confusions(ops_list):
    """count single-letter substitutions between OCR and typed words across the whole document.
    Real typos are rare, so letters that are swapped often are this scan's OCR habits."""
    _SUBS.clear()
    for ops,O,T in ops_list:
        for kind,oi,tj in ops:
            if kind!='sub' or len(oi)!=1 or len(tj)!=1: continue
            a,b=T[tj[0]]['n'],O[oi[0]]['n']
            if len(a)<3 or RL.distance(a,b)!=1: continue
            for op in RL.editops(a,b):
                if op.tag=='replace': _SUBS[(a[op.src_pos],b[op.dest_pos])]+=1
                elif op.tag=='delete': _SUBS[(a[op.src_pos],'')]+=1
                else: _SUBS[('',b[op.dest_pos])]+=1
def letter_cost(t,o):
    """cost of the print showing letter t while OCR reads o (0 = typical OCR slip, 1 = unexplained)"""
    n=_SUBS.get((t,o),0)
    if t and o and (t+o) in STATIC_CONF: return 0.15 if n>=2 else 0.25
    if n>=6: return 0.2
    if n>=3: return 0.4
    if (not t and o in 'וי') or (not o and t in 'וי'): return 0.35
    return 1.0
def channel_cost(t,o):
    """how far typed word(s) t are from OCR reading o once typical OCR slips are discounted"""
    ops=RL.editops(t,o); c=0.0
    for op in ops:
        if op.tag=='replace': c+=letter_cost(t[op.src_pos],o[op.dest_pos])
        elif op.tag=='delete': c+=letter_cost(t[op.src_pos],'')
        else: c+=letter_cost('',o[op.dest_pos])
    return c
def explained_by_ocr(o,t):
    return channel_cost(t,o) < 0.5*max(1,len(t)/4)

def _subseq(p,w):
    if not w or p[0]!=w[0]: return False
    k=0
    for ch in w:
        if k<len(p) and ch==p[k]: k+=1
    return k==len(p)
def abbr_expands(a, ws):
    """abbreviation letters a (e.g. 'ביהכפ') spell the starts of words ws (e.g. ['ביום','הכיפורים'])"""
    k=len(ws)
    if k==0 or len(a)<k: return False
    memo={}
    def rec(pos,i):
        if i==k: return pos==len(a)
        key=(pos,i)
        if key in memo: return memo[key]
        ok=False
        for e in range(pos+1, len(a)-(k-i-1)+1):
            p=a[pos:e]
            if (ws[i].startswith(p) or (len(p)>=2 and _subseq(p,ws[i][:len(p)+3]))) and rec(e,i+1): ok=True; break
        memo[key]=ok; return ok
    return rec(0,0)

def equiv1(o,t):
    """same word for proofreading purposes (spelling variants, abbreviation styles)"""
    a,b=o['n'],t['n']
    if a==b: return 0.0
    if plene(a,b): return 0.05
    if o['ab'] or t['ab']:
        s,l=(a,b) if len(a)<=len(b) else (b,a)
        sab=o['ab'] if s is a else t['ab']
        if sab and len(s)>=1 and abbr_expands(s,[l]): return 0.05
        if min(len(a),len(b))>=2 and len(a)>=2 and a[0] in 'הו' and a[1:]==b: return 0.1
        if min(len(a),len(b))>=2 and b[0] in 'הו' and b[1:]==a: return 0.1
    return None

def tokenize_typed(text, ignore_brackets=True, ignore_parens=True):
    """typed words with original string, normalized form and char offsets.
    Never flagged (but used for alignment): words in [square brackets] (editor-added sources),
    in (round brackets) (source references), and short editor headings that start with a
    Latin marker letter (as in some Hebrew PDFs where a heading glyph extracts as 'l' or 'u').
    An unclosed bracket stops counting after a few dozen words."""
    toks=[]; depth=0; dleft=0; pdepth=0; pleft=0; head=0
    for m in WORD_RE.finditer(text):
        w=m.group(0)
        o,c=w.count('['),w.count(']')
        inside = depth>0 or o>0
        depth=max(0,depth+o-c); dleft = 60 if o else dleft-1
        if dleft<=0: depth=0
        po,pc=w.count('('),w.count(')')
        pin = pdepth>0 or po>0
        pdepth=max(0,pdepth+po-pc); pleft = 25 if po else pleft-1
        if pleft<=0: pdepth=0
        if re.search(r'[A-Za-z]',w): head=14
        src=(ignore_brackets and inside) or (ignore_parens and pin) or head>0
        if head>0:
            head-=1
            if re.search(r'[.:]$',w): head=0
        n=norm_word(w)
        if n: toks.append(dict(t=w,n=n,s=m.start(),e=m.end(),ab=is_abbrev(w),src=bool(src)))
    return toks

FEATS=['agree','conf','inv_o','inv_t','chan','short','lost','edge','moved','nwords','k_changed','k_missing','k_extra','layout']
# weights learned on 5 held-out Prague pages (see README); logistic model over FEATS
WEIGHTS=None
def _sig(x): return 1/(1+math.exp(-x))
def score_flag(feat, weights=None):
    w=weights or WEIGHTS
    if not w: return feat.get('_hand',0.5)
    z=w.get('bias',0)+sum(w.get(k,0)*feat.get(k,0) for k in FEATS)
    return _sig(z)

def _norm_seq(words): return [w['n'] for w in words]
def _found_elsewhere(seq, pool_index, n=3):
    """is a run of words (or most of its 3-grams) present elsewhere? (text moved, not missing)"""
    if len(seq)<n: return 0.0
    grams=[tuple(seq[i:i+n]) for i in range(len(seq)-n+1)]
    return sum(1 for g in grams if g in pool_index)/len(grams)

def compare_page(passes, T, vocab=None, window=None, weights=None):
    """compare one scan page (one or more independent OCR passes of it) with the typed text.
    passes[0] is the main reading; the others vote. Returns flags (with a confidence 0..1) and the typed span."""
    O=passes[0]
    win=window or page_window(O,T)
    if win is None: return [], (0,0)
    views=[align(Ok,T,window=win) for Ok in passes]
    ops0,span=views[0]
    if not ops0: return [], (0,0)
    flags=flags_from_ops(ops0,O,T)
    pvs=[(pass_view(v[0]),passes[k+1]) for k,v in enumerate(views[1:])]
    # pools for "moved text" detection
    lo,hi=max(0,win[0]-1500),min(len(T),win[1]+1500)
    tpool=set(tuple(T[x]['n'] for x in range(j,j+3)) for j in range(lo,hi-3))
    opool=set()
    for Ok in passes:
        for i in range(len(Ok)-2): opool.add(tuple(o['n'] for o in Ok[i:i+3]))
    first_line={}; last_line={}
    for o in O:
        key=o.get('part',0)
        first_line[key]=min(first_line.get(key,10**9),o['line']); last_line[key]=max(last_line.get(key,-1),o['line'])
    out=[]
    for f in flags:
        ow=[O[x] for x in f['oi']]; tw=[T[x] for x in f['tj']]
        if f['kind']=='extra' and (min(f['tj'])<=span[0]+1 or max(f['tj'])>=span[1]-1): continue
        sup=con=0
        for (st,extra),Ok in pvs:
            if f['kind']=='changed':
                if all(st.get(j)=='eq' for j in f['tj']): con+=1
                else: sup+=1
            elif f['kind']=='extra':
                g=sum(1 for j in f['tj'] if st.get(j)=='gap')/len(f['tj'])
                if g>=0.5: sup+=1
                else: con+=1
            else:
                at=f.get('at'); near=[]
                if at is not None:
                    for x in range(at-3,at+4):
                        for run in extra.get(x,[]): near+=[Ok[i]['n'] for i in run]
                on=[w['n'] for w in ow]
                hit=sum(1 for a in on if any(_near(a,b) for b in near))
                if on and hit>=0.5*len(on): sup+=1
                else: con+=1
        npass=sup+con
        o1=''.join(w['n'] for w in ow); t1=''.join(w['n'] for w in tw)
        feat=dict(agree=(sup/npass) if npass else 0.5,
                  conf=(sum(w.get('c',80) for w in ow)/len(ow)/100.0) if ow else 0.85,
                  inv_o=_inv(ow,vocab) if ow else 1.0, inv_t=_inv(tw,vocab) if tw else 1.0,
                  nwords=min(6,max(len(ow),len(tw)))/6.0,
                  k_changed=float(f['kind']=='changed'), k_missing=float(f['kind']=='missing'), k_extra=float(f['kind']=='extra'))
        feat['chan']=min(1.0, channel_cost(t1,o1)/max(1,len(t1))) if f['kind']=='changed' else 1.0
        feat['short']=float(max(len(o1),len(t1))<=2)
        feat['lost']=float(f['kind']=='changed' and len(tw)>=3 and len(o1)<0.4*len(t1))
        feat['edge']=float(bool(ow) and any(w['line'] in (first_line.get(w.get('part',0)),last_line.get(w.get('part',0))) for w in ow))
        mv=0.0
        if f['kind']=='missing': mv=_found_elsewhere([w['n'] for w in ow],tpool)
        elif f['kind']=='extra': mv=_found_elsewhere([w['n'] for w in tw],opool)
        feat['moved']=mv
        feat['layout']=float(any(w['n'] in LAYOUT_WORDS for w in ow))
        # hand-set fallback score
        h=0.15+0.4*feat['agree']+0.15*feat['conf']+0.2*feat['inv_o']-0.3*(feat['chan']<0.3)-0.15*feat['short']-0.3*feat['moved']-0.3*feat['layout']-0.2*feat['lost']-0.1*feat['edge']
        feat['_hand']=max(0.0,min(1.0,h))
        f.update(typed=' '.join(w['t'] for w in tw), original=' '.join(w['t'] for w in ow),
                 j=(f['tj'][0] if f['tj'] else f.get('at')), feat=feat,
                 conf=round(score_flag(feat,weights),2), votes=f'{sup+1}/{npass+1}',
                 page=(ow[0]['page'] if ow else None),
                 box=(ow[0].get('box') if ow else None), line=(ow[0].get('line') if ow else None))
        out.append(f)
    return out, span

WEIGHTS={"agree": 1.095, "conf": 0.25, "inv_o": 0.881, "inv_t": 0.033, "chan": 0.054, "short": -0.078, "lost": 0.0, "edge": -0.203, "moved": -0.105, "nwords": 0.48, "k_changed": -0.094, "k_missing": -0.591, "k_extra": 0.442, "layout": 0.506, "bias": -4.073}
LEVEL_SURE=0.15; LEVEL_CHECK=0.10

def finalize(flags):
    """last pass: a long typed passage the OCR could barely read is 'unread', not a mistake;
    a scan word that is only a layout label (e.g. 'גליון') is dropped"""
    out=[]
    for f in flags:
        o1=sum(len(x) for x in f['original'].split()); t1=sum(len(x) for x in f['typed'].split())
        if f['kind']=='changed' and len(f['tj'])>=3 and o1<0.5*t1: f['kind']='unread'
        if f['kind']=='missing' and f['feat'].get('layout'): continue
        out.append(f)
    return out

def level(c, hi=LEVEL_SURE, mid=LEVEL_CHECK):
    return 'sure' if c>=hi else ('check' if c>=mid else 'low')

def _crop_b64(img, box, pad=10, width=900):
    import base64, io
    if img is None or not box: return None
    b=box; c=img.crop((max(0,b[0]-pad),max(0,b[1]-pad),min(img.width,b[2]+pad),min(img.height,b[3]+pad))).convert('L')
    if c.width>width: c=c.resize((width,max(1,int(c.height*width/c.width))))
    bio=io.BytesIO(); c.save(bio,'JPEG',quality=70); return base64.b64encode(bio.getvalue()).decode()

def _marks(flags, T, mid):
    at=defaultdict(list); start={}
    for f in flags:
        if f['conf']<mid or f['kind']=='unread': continue
        if f['kind']=='missing':
            at[f['j'] if f['j'] is not None else len(T)-1].append(f)
        elif f['tj']:
            start[f['tj'][0]]=f
    return at,start

KIND_HE={'changed':'שינוי','missing':'חסר','extra':'אינו במקור','unread':'לא נקרא'}
def html_report(typed_text, T, flags, span, out, title='Proofread report', hi=LEVEL_SURE, mid=LEVEL_CHECK, images=None):
    at,start=_marks(flags,T,mid)
    spans=span if isinstance(span,list) else [span]
    parts=[]; n=0
    for si,sp in enumerate(spans):
      j0=max(0,sp[0]-20); j1=min(len(T)-1,sp[1]+20)
      if len(spans)>1: parts.append(f'<h3 class="pg">— scan page {si+1} —</h3>')
      pos=T[j0]['s']; j=j0
      while j<=j1:
          t=T[j]; parts.append(html.escape(typed_text[pos:t['s']]))
          for f in at.get(j,[]):
              n+=1; cls='miss '+('hi' if f['conf']>=hi else 'mid')
              parts.append(f'<a id="f{n}" href="#d{n}" class="{cls}" title="{f["votes"]} readings · confidence {f["conf"]}">[חסר: {html.escape(f["original"])}]</a> ')
              f['_n']=n
          if j in start:
              f=start[j]; jj=f['tj'][-1]; seg=typed_text[t['s']:T[jj]['e']]; n+=1; f['_n']=n
              cls={'changed':'chg','extra':'ext'}[f['kind']]+(' hi' if f['conf']>=hi else ' mid')
              note=f' <span class="orig">[במקור: {html.escape(f["original"])}]</span>' if f['kind']=='changed' else ' <span class="orig">[אינו במקור]</span>'
              parts.append(f'<a id="f{n}" href="#d{n}" class="{cls}" title="{KIND_HE[f["kind"]]} · confidence {f["conf"]}">{html.escape(seg)}</a>{note}')
              pos=T[jj]['e']; j=jj+1; continue
          parts.append(html.escape(typed_text[t['s']:t['e']])); pos=t['e']; j+=1
    body=''.join(parts).replace('\n','<br>')
    # list of flags with scan crops
    rows=[]
    for f in sorted([f for f in flags if f.get('_n')],key=lambda f:f['_n']):
        img=None
        if images is not None and f.get('page') is not None and f['page']<len(images): img=images[f['page']]
        b64=_crop_b64(img,f.get('box'))
        pic=f'<br><img src="data:image/jpeg;base64,{b64}">' if b64 else ''
        rows.append(f'<div class="row" id="d{f["_n"]}"><a href="#f{f["_n"]}">#{f["_n"]}</a> <b>{KIND_HE[f["kind"]]}</b> · {level(f["conf"],hi,mid)} ({f["conf"]}) · scan page {(f["page"] or 0)+1} · OCR readings agreeing {f["votes"]}<br>'
                    f'הקלדה: <span class="t">{html.escape(f["typed"]) or "—"}</span> &nbsp; במקור (OCR): <span class="o">{html.escape(f["original"]) or "—"}</span>{pic}</div>')
    unread=[f for f in flags if f['kind']=='unread']
    n_hi=sum(1 for f in flags if f['conf']>=hi and f['kind']!='unread'); n_mid=sum(1 for f in flags if mid<=f['conf']<hi and f['kind']!='unread')
    css="""body{font-family:'David Libre','Frank Ruehl CLM','Times New Roman',serif;direction:rtl;max-width:900px;margin:auto;line-height:1.9;font-size:19px;padding:12px}
a{color:inherit;text-decoration:none}.chg.hi{background:#ffeb3b}.chg.mid{background:#ffcc80}.ext.hi{background:#ef9a9a;text-decoration:line-through}.ext.mid{background:#ffcdd2;text-decoration:line-through}
.miss{color:#c62828;font-weight:bold}.miss.mid{color:#ef6c00}.orig{color:#c62828;font-size:85%}.legend span{padding:0 6px;margin-left:8px}
.row{border-top:1px solid #ddd;padding:8px 0;font-size:16px}.row img{max-width:100%;border:1px solid #ccc;margin-top:4px}.t{background:#fff3c4}.o{background:#e3f2fd}"""
    legend='<div class="legend"><span class="chg hi">צהוב = שינוי (בטוח יותר)</span><span class="chg mid">כתום = לבדוק</span><span class="ext hi">אדום מחוק = אינו במקור</span><span class="miss">[חסר: …] = חסר בהקלדה</span></div>'
    doc=(f'<!doctype html><html lang="he"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(title)}</title><style>{css}</style><body>'
         f'<h2>{html.escape(title)}</h2><p>{n_hi} flags marked sure, {n_mid} to check, {len(unread)} passages the OCR could not read well (not flagged). Made offline with hebocr, no AI. '
         f'Every flag is a machine guess from OCR: check it against the scan picture below before changing the text.</p>{legend}<hr>{body}<hr><h3>All flags, with the scan line</h3>{"".join(rows)}</body></html>')
    open(out,'w',encoding='utf-8').write(doc)
    return out

def docx_report(typed_text, T, flags, span, out, hi=LEVEL_SURE, mid=LEVEL_CHECK):
    import docx
    from docx.enum.text import WD_COLOR_INDEX
    from docx.shared import RGBColor, Pt
    from docx.oxml.ns import qn
    d=docx.Document(); st=d.styles['Normal']; st.font.size=Pt(13)
    at,start=_marks(flags,T,mid)
    spans=span if isinstance(span,list) else [span]
    def newpar():
        p=d.add_paragraph()
        pPr=p._p.get_or_add_pPr(); pPr.append(pPr.makeelement(qn('w:bidi'),{}))
        return p
    def run(p,text,color=None,hl=None,strike=False):
        r=p.add_run(text); r.font.rtl=True
        if color: r.font.color.rgb=RGBColor(*color)
        if hl: r.font.highlight_color=hl
        if strike: r.font.strike=True
        return r
    p=newpar(); run(p,'דוח הגהה (ללא AI): צהוב = שינוי, טורקיז = לבדוק, ורוד מחוק = אינו במקור, [חסר: …] = חסר בהקלדה. כל סימון הוא ניחוש של OCR, יש לבדוק מול הסריקה.',color=(0x55,0x55,0x55))
    for si,sp in enumerate(spans):
      j0=max(0,sp[0]-20); j1=min(len(T)-1,sp[1]+20)
      if len(spans)>1: p=newpar(); run(p,f'— עמוד סריקה {si+1} —',color=(0x55,0x55,0x55))
      p=newpar(); j=j0
      while j<=j1:
            t=T[j]; gap=typed_text[T[j-1]['e'] if j>j0 else t['s']:t['s']]
            if '\n' in gap: p=newpar()
            elif j>j0: run(p,' ')
            for f in at.get(j,[]): run(p,f'[חסר: {f["original"]}] ',color=(0xC6,0x28,0x28))
            if j in start:
                f=start[j]; jj=f['tj'][-1]; seg=typed_text[t['s']:T[jj]['e']]
                if f['kind']=='changed':
                    run(p,seg,hl=WD_COLOR_INDEX.YELLOW if f['conf']>=hi else WD_COLOR_INDEX.TURQUOISE); run(p,f' [במקור: {f["original"]}]',color=(0xC6,0x28,0x28))
                else:
                    run(p,seg,hl=WD_COLOR_INDEX.PINK,strike=True); run(p,' [אינו במקור]',color=(0xC6,0x28,0x28))
                j=jj+1; continue
            run(p,typed_text[t['s']:t['e']]); j+=1
    d.save(out); return out

def compare_all(page_passes, T, vocab=None, weights=None, learn=True):
    """page_passes: for each scan page, a list of OCR token lists (independent readings of that page)"""
    if learn:
        L=[]
        for passes in page_passes:
            win=page_window(passes[0],T)
            if win is None: continue
            ops,_=align(passes[0],T,window=win); L.append((ops,passes[0],T))
        learn_confusions(L)
    flags=[]; spans=[]
    for p,passes in enumerate(page_passes):
        f,sp=compare_page(passes,T,vocab,weights=weights)
        for x in f:
            if x['page'] is None: x['page']=p
            else: x['page']=p
        flags+=f
        if sp!=(0,0): spans.append(sp)
    flags=finalize(flags)
    flags.sort(key=lambda f:(f['j'] if f['j'] is not None else 10**9))
    return flags, (spans or [(0,0)])

def load_vocab(lm_dir, min_count=2):
    import gzip
    path=os.path.join(lm_dir,'unigrams.tsv.gz')
    if not os.path.exists(path): return None
    v=set()
    for line in gzip.open(path,'rt',encoding='utf-8'):
        w,c=line.rstrip('\n').split('\t')[:2]
        if int(c)>=min_count: v.add(norm_word(w))
    return v

def proofread(typed, page_results, out_prefix, vocab=None, title=None, images=None, hi=LEVEL_SURE, mid=LEVEL_CHECK):
    """typed: path to .txt/.docx/.pdf (or the text itself). page_results: for each scan page, a list of
    engine results (one per OCR reading). images: the prepared page images (for scan crops in the HTML)."""
    text=load_typed(typed) if os.path.exists(typed) else typed
    T=tokenize_typed(text)
    pp=[[ocr_tokens([r])[:] for r in reads] for reads in page_results]
    flags,span=compare_all(pp,T,vocab)
    for f in flags: f['level']=level(f['conf'],hi,mid)
    keep=['kind','typed','original','conf','level','votes','page','box','j']
    json.dump(dict(flags=[{k:f.get(k) for k in keep} for f in flags],span=span),open(out_prefix+'.json','w'),ensure_ascii=False,indent=0)
    html_report(text,T,flags,span,out_prefix+'.html',title or 'Proofread report',hi,mid,images)
    try: docx_report(text,T,flags,span,out_prefix+'.docx',hi,mid)
    except Exception as e: print('docx failed:',e)
    return flags
