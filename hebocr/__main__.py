"""Command line:  python3 -m hebocr ocr ...   |   python3 -m hebocr proofread ...   (run from the repo folder)"""
import argparse, os, sys, json
from . import engine as E

def parse_pages(s):
    if not s: return None
    out=[]
    for part in s.split(','):
        if '-' in part: a,b=part.split('-'); out+=list(range(int(a),int(b)+1))
        else: out.append(int(part))
    return out

def cmd_ocr(a):
    pages=parse_pages(a.pages)
    ims=E.load_pages(a.input, dpi=a.dpi, pages=pages)
    texts=[]
    for k,im in enumerate(ims):
        if a.scale!=1: im=im.resize((int(im.width*a.scale),int(im.height*a.scale)))
        r=E.ocr_page(im, script=a.script, layout=a.layout, correct=a.correct)
        texts.append(r['text']); print(f'page {k+1}/{len(ims)} done', file=sys.stderr)
    out='\n\n\f'.join(texts) if len(texts)>1 else (texts[0] if texts else '')
    if a.out: open(a.out,'w',encoding='utf-8').write(out); print('wrote', a.out, file=sys.stderr)
    else: print(out)

def cmd_proofread(a):
    from . import proofread as P
    pages=parse_pages(a.pages)
    ims=E.load_pages(a.scan, dpi=a.dpi, pages=pages)
    scales=[float(x) for x in a.scales.split(',')][:max(1,a.passes)]
    page_results=[]; images=[]
    for k,im in enumerate(ims):
        reads=[]
        for si,sc in enumerate(scales):
            im2=im.resize((int(im.width*sc),int(im.height*sc))) if sc!=1 else im
            r=E.ocr_page(im2, script=a.script, layout=a.layout, correct=False)
            reads.append(r)
            if si==0: images.append(E.prepared_image(im2, r['info']))
        page_results.append(reads); print(f'scan page {k+1}/{len(ims)} read {len(reads)}x', file=sys.stderr)
    vocab=None if a.no_vocab else P.load_vocab(E.LMDIR)
    flags=P.proofread(a.typed, page_results, a.out, vocab=vocab, title=a.title or os.path.basename(a.typed), images=images,
                      hi=a.sure, mid=a.check)
    from collections import Counter
    c=Counter((f['kind'],f['level']) for f in flags if f['level']!='low')
    print(json.dumps({'report':a.out+'.html','docx':a.out+'.docx','flags':{f'{k}/{l}':n for (k,l),n in sorted(c.items())}}, ensure_ascii=False))

def main(argv=None):
    ap=argparse.ArgumentParser(prog='hebocr', description='Offline Hebrew OCR (square + Rashi script) and proofreading, no AI.')
    sub=ap.add_subparsers(dest='cmd', required=True)
    o=sub.add_parser('ocr', help='read a scan (PDF or image) into text')
    o.add_argument('input'); o.add_argument('--out','-o')
    o.add_argument('--script', default='auto', choices=['auto','rashi','square'])
    o.add_argument('--layout', default='auto', choices=['auto','columns','block','line'])
    o.add_argument('--pages', help='PDF pages, e.g. 1,3-5 (1-based)')
    o.add_argument('--dpi', type=int, default=300); o.add_argument('--scale', type=float, default=1.0)
    o.add_argument('--correct', action='store_true', help='word-list spelling fix (small help on square, about flat on Rashi)')
    o.add_argument('--rashi-model', help='Rashi model in models/ (default heb_rashi7; e.g. heb_rashi6)')
    o.set_defaults(fn=cmd_ocr)
    p=sub.add_parser('proofread', help='compare a typed text (.txt/.docx/.pdf) with the original scan')
    p.add_argument('typed'); p.add_argument('scan'); p.add_argument('--out','-o', default='proofread_report')
    p.add_argument('--pages', help='scan pages to check, e.g. 15,25 or 10-20')
    p.add_argument('--script', default='rashi', choices=['auto','rashi','square'])
    p.add_argument('--layout', default='columns', choices=['auto','columns','block'])
    p.add_argument('--passes', type=int, default=3, help='independent OCR readings per page (they vote); 1 is fastest')
    p.add_argument('--scales', default='1.2,1.0,1.4'); p.add_argument('--dpi', type=int, default=300)
    p.add_argument('--sure', type=float, default=0.15, help='confidence for a "sure" (yellow) flag')
    p.add_argument('--check', type=float, default=0.10, help='confidence for a "to check" (orange) flag')
    p.add_argument('--no-vocab', action='store_true'); p.add_argument('--title')
    p.add_argument('--rashi-model', help='Rashi model in models/ (default heb_rashi7; e.g. heb_rashi6)')
    p.set_defaults(fn=cmd_proofread)
    a=ap.parse_args(argv)
    if getattr(a,'rashi_model',None): E.set_rashi_model(a.rashi_model)
    a.fn(a)

if __name__=='__main__': main()
