
import os, sys, json, re, subprocess, requests, time, unicodedata
import numpy as np
from PIL import Image
from concurrent.futures import ThreadPoolExecutor
os.environ['OMP_THREAD_LIMIT']='1'
W=sys.argv[1]; ident=sys.argv[2]; leaves=[int(x) for x in sys.argv[3].split(',')]; outdir=sys.argv[4]
TD='./tess'
os.makedirs(outdir,exist_ok=True)
def log(m): open(outdir+'/log.txt','a').write(time.strftime('%H:%M:%S ')+m+'\n')
def tsv(path, lang):
    r=subprocess.run(['timeout','-k','5','170','tesseract',path,'-','--tessdata-dir',TD,'-l',lang,'--psm','3','tsv'],capture_output=True,text=True)
    lines={}
    for row in r.stdout.split('\n')[1:]:
        f=row.split('\t')
        if len(f)<12: continue
        lv=f[0]; key=(int(f[2]),int(f[3]),int(f[4]))
        if lv=='4': lines[key]={'box':[int(f[6]),int(f[7]),int(f[8]),int(f[9])],'words':[],'conf':[]}
        elif lv=='5' and f[11].strip() and key in lines:
            lines[key]['words'].append(f[11]); lines[key]['conf'].append(float(f[10]))
    return [dict(box=v['box'],text=' '.join(v['words']),conf=float(np.mean(v['conf'])) if v['conf'] else 0) for v in lines.values() if v['words']]
def do(leaf):
    out=f'{outdir}/n{leaf:04d}.json'
    if os.path.exists(out): return
    jpg=f'{outdir}/n{leaf:04d}.jpg'
    if not os.path.exists(jpg):
        for a in range(3):
            try:
                r=requests.get(f'https://archive.org/download/{ident}/page/n{leaf}.jpg',timeout=120); r.raise_for_status(); open(jpg,'wb').write(r.content); break
            except Exception as e: log(f'dl err {leaf} {e}'); time.sleep(5)
    png=f'{outdir}/n{leaf:04d}.png'
    Image.open(jpg).convert('L').save(png)
    res={'rashi':tsv(png,'heb_rashi'),'heb':tsv(png,'heb_best')}
    os.remove(png)
    json.dump(res,open(out,'w'),ensure_ascii=False); log(f'leaf {leaf} lines {len(res["rashi"])}/{len(res["heb"])}')
with ThreadPoolExecutor(int(sys.argv[5]) if len(sys.argv)>5 else 3) as ex: list(ex.map(do,leaves))
log('DONE')
