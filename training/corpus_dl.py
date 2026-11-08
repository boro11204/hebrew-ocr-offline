
import os, sys, json, re, requests, time, urllib.parse
from concurrent.futures import ThreadPoolExecutor
OUT=sys.argv[1]; titles=json.load(open(sys.argv[2])); os.makedirs(OUT,exist_ok=True)
def log(m): open(OUT+'/log.txt','a').write(time.strftime('%H:%M:%S ')+m+'\n')
def get(title):
    fn=OUT+'/'+title.replace(' ','_').replace(',','')+'.txt'
    if os.path.exists(fn): return
    try:
        vs=requests.get('https://www.sefaria.org/api/texts/versions/'+urllib.parse.quote(title),timeout=60).json()
        he=[v for v in vs if v.get('language')=='he']
        pref=[v for v in he if 'Wikisource' in v['versionTitle'] or 'Vilna' in v['versionTitle']] or he
        if not pref: log('nover '+title); return
        vt=pref[0]['versionTitle']
        u='https://www.sefaria.org/download/version/'+urllib.parse.quote(f'{title} - he - {vt}')+'.txt'
        r=requests.get(u,timeout=120)
        if r.status_code!=200 or r.text.lstrip().startswith('<!DOCTYPE'): log(f'fail {title} {vt} {r.status_code}'); return
        t=re.sub(r'<[^>]+>','',r.text)
        lines=[l for l in t.split('\n')[8:] if re.search('[\u05d0-\u05ea]{2}',l)]
        open(fn,'w').write('\n'.join(lines)); log(f'ok {title} [{vt}] {len(t)}')
    except Exception as e: log(f'exc {title} {e}')
with ThreadPoolExecutor(4) as ex: list(ex.map(get,titles))
log('DONE')
