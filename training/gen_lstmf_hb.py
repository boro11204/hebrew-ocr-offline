
import os, sys, subprocess, glob
from PIL import Image
from concurrent.futures import ThreadPoolExecutor
os.environ['OMP_THREAD_LIMIT']='1'
TD='./tess'
files=[l.strip() for l in open(sys.argv[1]) if l.strip()]
def box(png):
    gt=open(png[:-4]+'.gt.txt').read().strip()
    w,h=Image.open(png).size
    with open(png[:-4]+'.box','w') as f:
        for ch in gt[::-1]:
            if ch==' ': ch=' '
            f.write(f'{ch} 0 0 {w} {h} 0\n')
        f.write(f'\t {w} 0 {w+1} {h} 0\n')
    base=png[:-4]
    if not os.path.exists(base+'.lstmf'):
        subprocess.run(['timeout','-k','5','60','tesseract',png,base,'--tessdata-dir',TD,'-l','heb_best','--psm','13','lstm.train'],capture_output=True)
    return os.path.exists(base+'.lstmf')
with ThreadPoolExecutor(3) as ex: ok=list(ex.map(box,files))
print(sum(ok),len(ok))
