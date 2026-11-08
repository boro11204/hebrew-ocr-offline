
"""No-AI spelling correction for Hebrew OCR: noisy channel + word bigram model."""
import gzip, math, re, json, os
from collections import defaultdict
HEB='אבגדהוזחטיכלמנסעפצקרשתךםןףץ'
FIN={'כ':'ך','מ':'ם','נ':'ן','פ':'ף','צ':'ץ'}; UNFIN={v:k for k,v in FIN.items()}
WORD=re.compile(r'[\u05d0-\u05ea]+(?:[״"׳\'][\u05d0-\u05ea]+)*[׳\']?')
def fix_finals(w):
    core=w.rstrip('׳\'')
    if not core: return w
    s=''.join(UNFIN.get(c,c) for c in core[:-1])+FIN.get(core[-1],core[-1]) if core[-1] in FIN else ''.join(UNFIN.get(c,c) for c in core[:-1])+core[-1]
    # don't finalize before gershayim abbreviations (handled by WORD)
    return s+w[len(core):]
class LM:
    def __init__(self, d):
        self.u={}; self.b={}; self.N=1
        with gzip.open(os.path.join(d,'unigrams.tsv.gz'),'rt') as f:
            for line in f:
                w,c=line.rstrip('\n').split('\t')
                if w=='#tokens': self.N=int(c); continue
                self.u[w]=int(c)
        with gzip.open(os.path.join(d,'bigrams.tsv.gz'),'rt') as f:
            for line in f:
                k,c=line.rstrip('\n').split('\t'); self.b[k]=int(c)
        self.V=len(self.u)
        self.dele=defaultdict(set)
        for w in self.u:
            if len(w)>15: continue
            for i in range(len(w)): self.dele[w[:i]+w[i+1:]].add(w)
    def lp1(self,w):
        return math.log((self.u.get(w,0)+0.1)/(self.N+0.1*self.V))
    def lp2(self,prev,w):
        if prev is not None:
            c=self.b.get(prev+' '+w)
            if c: return math.log(c/self.u.get(prev,c))  # MLE bigram
            return math.log(0.4)+self.lp1(w)  # stupid backoff
        return self.lp1(w)
class Corrector:
    def __init__(self, lm_dir, confusion=None, sub_cost=4.0, indel_cost=5.0, oov_pen=6.0, margin=1.0, inv_mult=2.0, uni_w=0.6, topk=15, split_cost=2.0):
        self.lm=LM(lm_dir); self.sub_cost=sub_cost; self.indel=indel_cost; self.oov_pen=oov_pen; self.margin=margin; self.inv_mult=inv_mult; self.uni_w=uni_w; self.topk=topk; self.split_cost=split_cost
        self.conf={}
        if confusion:
            raw=json.load(open(confusion))
            for k,v in raw.items(): self.conf[k]=v   # "a>b": cost
        self.cache={}
    def cost_sub(self,a,b):
        if a==b: return 0.0
        if UNFIN.get(a,a)==UNFIN.get(b,b): return 0.3
        c=self.conf.get(a+'>'+b)
        if c is None:
            c2=self.conf.get(b+'>'+a); c=c2+0.5 if c2 is not None else self.sub_cost
        return c
    def candidates(self, w):
        if w in self.cache: return self.cache[w]
        out={}
        L=self.lm
        base=w
        cands=set()
        if base in L.u: cands.add(base)
        ff=fix_finals(base)
        if ff in L.u: cands.add(ff)
        # same-length substitutions via confusion (1 and 2 edits)
        subs=defaultdict(list)
        for k in self.conf:
            a,b=k.split('>'); subs[a].append(b)
        for i,c in enumerate(base):
            for b in subs.get(c,[])+([FIN[c]] if c in FIN else [])+([UNFIN[c]] if c in UNFIN else []):
                w1=base[:i]+b+base[i+1:]
                if w1 in L.u: cands.add(w1)
                for j in range(i+1,len(base)):
                    for b2 in subs.get(base[j],[]):
                        w2=w1[:j]+b2+w1[j+1:]
                        if w2 in L.u: cands.add(w2)
        # deletion index: words one char longer/shorter or one sub (generic)
        dels={base}|{base[:i]+base[i+1:] for i in range(len(base))}
        for d in dels:
            for c in L.dele.get(d,()): cands.add(c)
            if d in L.u: cands.add(d)
        for c in cands:
            out[c]=self.channel(base,c)
        res=sorted(out.items(),key=lambda x:x[1]-self.uni_w*L.lp1(x[0]))[:self.topk]
        # split into two words (missing space)
        if base not in L.u and len(base)>=4:
            best=None
            for i in range(2,len(base)-1):
                a,b=base[:i],fix_finals(base[:i]) ,
                a=fix_finals(base[:i]); b=base[i:]
                if a in L.u and b in L.u and L.u[a]>=20 and L.u[b]>=20:
                    s=L.lp1(a)+L.lp1(b)
                    if best is None or s>best[0]: best=(s,a+' '+b)
            if best: res.append((best[1], self.split_cost))
        self.cache[w]=res; return res
    def channel(self,a,b):
        n,m=len(a),len(b); D=[[0.0]*(m+1) for _ in range(n+1)]
        for i in range(1,n+1): D[i][0]=i*self.indel
        for j in range(1,m+1): D[0][j]=j*self.indel
        for i in range(1,n+1):
            for j in range(1,m+1):
                D[i][j]=min(D[i-1][j]+self.indel, D[i][j-1]+self.indel, D[i-1][j-1]+self.cost_sub(a[i-1],b[j-1]))
        return D[n][m]
    def _lp_seq(self, prev, cand):
        L=self.lm; parts=cand.split(' '); s=0.0; p=prev
        for w in parts: s+=L.lp2(p,w); p=w
        return s, p
    def correct_tokens(self, words, confs=None):
        """words: OCR word strings. Viterbi over candidate lattice with bigram LM; returns corrected list."""
        L=self.lm; lat=[]
        for k,w in enumerate(words):
            cf=(confs[k] if confs else 50.0)
            wt=1.0 if cf<70 else (1.6 if cf<90 else 2.5)
            inv=w in L.u
            if inv: wt*=self.inv_mult
            cs={w: 0.0 if inv else self.oov_pen}
            for c,ch in self.candidates(w):
                if c!=w: cs[c]=min(cs.get(c,1e9), ch*wt)
            lat.append(list(cs.items()))
        best={None:(0.0,[])}
        for cs in lat:
            nb={}
            for c,ch in cs:
                bestv=None
                for p,(s,path) in best.items():
                    lp,last=self._lp_seq(p,c); v=s+lp-ch
                    if bestv is None or v>bestv[0]: bestv=(v,path+[c],last)
                key=bestv[2]
                if key not in nb or bestv[0]>nb[key][0]: nb[key]=(bestv[0],bestv[1])
            best=nb
        path=max(best.values(),key=lambda x:x[0])[1] if best else list(words)
        out=[]
        for k,(w,c) in enumerate(zip(words,path)):
            if c==w: out.append(w); continue
            p=out[-1].split(' ')[-1] if out else None; nx=path[k+1].split(' ')[0] if k+1<len(path) else None
            chd=dict(lat[k])
            def sc(x):
                lp,last=self._lp_seq(p,x)
                return lp+(L.lp2(last,nx) if nx else 0)-chd.get(x,0)
            out.append(c if sc(c)-sc(w)>self.margin else w)
        return out
    def correct_line(self, line, confs=None):
        toks=re.split(r'(\s+)',line); idx=[]; words=[]
        for i,t in enumerate(toks):
            m=WORD.fullmatch(t.strip('.:,;()[]-–'))
            if m and len(m.group(0))>=2 and not re.search(r'[״"׳\']',t):
                idx.append(i); words.append(m.group(0))
        if not words: return line, []
        new=self.correct_tokens(words, confs)
        ch=[]
        for i,w,n in zip(idx,words,new):
            if n!=w: toks[i]=toks[i].replace(w,n,1); ch.append((w,n))
        return ''.join(toks), ch
