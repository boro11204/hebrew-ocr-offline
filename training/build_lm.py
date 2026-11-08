
import os, re, sys, glob, gzip, json, collections, unicodedata
C=sys.argv[1]; OUT=sys.argv[2]; EXCL=['Berakhot','Rosh_Hashanah']
WRE=re.compile(r'[\u05d0-\u05ea]+(?:[״"׳\'][\u05d0-\u05ea]+)*[׳\']?')
uni=collections.Counter(); bi=collections.Counter(); ntok=0
for f in sorted(glob.glob(C+'/*.txt')):
    b=os.path.basename(f)
    if any(b==e+'.txt' or b.endswith('on_'+e+'.txt') for e in EXCL): continue
    for line in open(f):
        line=re.sub(r'[\u0591-\u05C7]','',line)
        line=re.sub(r'\([^)]{0,40}\)',' ',line)
        ws=[w.replace('"','״').replace("'",'׳') for w in WRE.findall(line)]
        uni.update(ws); bi.update(zip(ws,ws[1:])); ntok+=len(ws)
u={w:c for w,c in uni.items() if c>=2}
b={k:c for k,c in bi.items() if c>=3 and k[0] in u and k[1] in u}
with gzip.open(OUT+'/unigrams.tsv.gz','wt') as f:
    f.write(f'#tokens\t{ntok}\n')
    for w,c in sorted(u.items(),key=lambda x:-x[1]): f.write(f'{w}\t{c}\n')
with gzip.open(OUT+'/bigrams.tsv.gz','wt') as f:
    for (a,c_),n in sorted(b.items(),key=lambda x:-x[1]): f.write(f'{a} {c_}\t{n}\n')
print(ntok,len(uni),len(u),len(bi),len(b))
