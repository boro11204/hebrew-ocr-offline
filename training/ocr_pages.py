
import sys, json, os, time
sys.path.insert(0, sys.argv[1])
from hebocr import engine as E
from concurrent.futures import ThreadPoolExecutor
pdf=sys.argv[2]; pages=[int(x) for x in sys.argv[3].split(',')]; out=sys.argv[4]; script=sys.argv[5]; os.makedirs(out,exist_ok=True)
def do(p):
    fn=f'{out}/p{p:03d}.json'
    if os.path.exists(fn): return
    im=E.load_pages(pdf,dpi=300,pages=[p])[0]
    sc=float(os.environ.get('SCALE','1'))
    if sc!=1: im=im.resize((int(im.width*sc),int(im.height*sc)))
    r=E.ocr_page(im, script=script, layout='columns', correct=(os.environ.get('CORR','0')=='1'))
    json.dump(r, open(fn,'w'), ensure_ascii=False)
    print(p, time.strftime('%H:%M:%S'), flush=True)
with ThreadPoolExecutor(int(sys.argv[6]) if len(sys.argv)>6 else 2) as ex: list(ex.map(do,pages))
print('DONE', flush=True)
