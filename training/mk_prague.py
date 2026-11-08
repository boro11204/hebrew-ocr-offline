
import os, sys, json, re, subprocess, time
import numpy as np
from PIL import Image
from rapidfuzz.distance import Levenshtein as RL
from concurrent.futures import ThreadPoolExecutor
os.environ['OMP_THREAD_LIMIT']='1'
P='./'; SCAN=P+'scan.pdf'
TD='./tess'
OUT=sys.argv[1]; pages=[int(x) for x in sys.argv[2].split(',')]; os.makedirs(OUT,exist_ok=True)
TMP=OUT+'/_tmp'; os.makedirs(TMP,exist_ok=True)
def log(m): open(OUT+'/log.txt','a').write(time.strftime('%H:%M:%S ')+m+'\n')
def crops(pg):
    out=f'{TMP}/p{pg:03d}'
    subprocess.run(["timeout","-k","5","120","pdftoppm","-r","300","-gray","-f",str(pg),"-l",str(pg),"-png","-singlefile",SCAN,out],check=True)
    im=Image.open(out+'.png').convert("L"); os.remove(out+'.png'); a=np.asarray(im); h,w=a.shape
    dark=(a<110).astype(np.int32)
    cp=dark[int(h*.1):int(h*.9)].sum(0); sm=np.convolve(cp,np.ones(15)/15,'same')
    lo,hi=int(w*.38),int(w*.62); gx=lo+int(np.argmin(sm[lo:hi]))
    res=[]
    for ci,(x0,x1) in enumerate([(gx-10,w),(0,gx+10)]):
        rp=dark[:,x0:x1].sum(1); rs=np.convolve(rp,np.ones(9)/9,'same')
        cuts=[0]; y=0
        while h-y>1150:
            t0,t1=y+800,y+1050; c=t0+int(np.argmin(rs[t0:t1])); cuts.append(c); y=c
        cuts.append(h)
        for k in range(len(cuts)-1): res.append((ci,k,im.crop((x0,cuts[k],x1,cuts[k+1]))))
    return res
def tsvlines(path):
    r=subprocess.run(['timeout','-k','5','120','tesseract',path,'-','--tessdata-dir',TD,'-l','heb_rashi','--psm','4','tsv'],capture_output=True,text=True)
    L={}
    for row in r.stdout.split('\n')[1:]:
        f=row.split('\t')
        if len(f)<12: continue
        key=(int(f[2]),int(f[3]),int(f[4]))
        if f[0]=='4': L[key]={'box':[int(f[6]),int(f[7]),int(f[8]),int(f[9])],'w':[]}
        elif f[0]=='5' and f[11].strip() and key in L: L[key]['w'].append(f[11])
    return [ (v['box'],' '.join(v['w'])) for v in L.values() if v['w']]
L2=re.compile(r'[^\u05d0-\u05ea ]')
def n(t): return re.sub(r'\s+',' ',L2.sub(' ',t)).strip()
def do(pg):
    fn=f'{OUT}/p{pg:03d}.done'
    if os.path.exists(fn): return
    oc=json.load(open(P+f'ocr/p{pg:03d}.json')); od={(o['col'],o['chunk']):o for o in oc}
    kept=0; tot=0
    for ci,k,img in crops(pg):
        o=od.get((ci,k))
        if not o or not o.get('text'): continue
        ol=[l.strip() for l in o['text'].split('\n') if l.strip()]
        cp=f'{TMP}/c{pg}_{ci}_{k}.png'; img.save(cp)
        tl=tsvlines(cp); os.remove(cp)
        for box,t in tl:
            tot+=1
            if not ol: continue
            nt=n(t)
            if len(nt)<8: continue
            sc=[RL.normalized_distance(nt,n(x)) for x in ol]; j=int(np.argmin(sc))
            if sc[j]>0.45: continue
            x0,y0,bw,bh=box
            if bh<20 or bh>140 or bw<200: continue
            crop=img.crop((max(0,x0-6),max(0,y0-6),min(img.width,x0+bw+6),min(img.height,y0+bh+6)))
            base=f'{OUT}/pr{pg:03d}_{ci}{k}_{y0:04d}'
            crop.save(base+'.png'); open(base+'.gt.txt','w').write(ol[j].replace("'","׳").replace('"','״')+'\n'); open(base+'.ocr.txt','w').write(t+'\n'); kept+=1
    open(fn,'w').write(f'{kept}/{tot}'); log(f'page {pg} kept {kept}/{tot}')
with ThreadPoolExecutor(int(sys.argv[3]) if len(sys.argv)>3 else 2) as ex: list(ex.map(do,pages))
log('DONE')
