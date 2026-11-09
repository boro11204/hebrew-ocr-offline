
import numpy as np, random, math
from PIL import Image, ImageFilter
def _blob_field(h,w,n,rmin,rmax,rng):
    f=np.zeros((h,w),np.float32); yy,xx=np.mgrid[0:h,0:w]
    for _ in range(n):
        cy,cx=rng.uniform(0,h),rng.uniform(0,w); r=rng.uniform(rmin,rmax)
        f+=np.exp(-(((yy-cy)/max(1,r*rng.uniform(.5,1.5)))**2+((xx-cx)/r)**2))
    return np.clip(f,0,1)
def degrade_base(im, rng=None, strength=0.8):
    """im: L-mode line image (dark ink on light paper). Returns a worn/degraded copy."""
    rng=rng or random.Random()
    a=np.asarray(im.convert('L'),np.float32)/255.0
    h,w=a.shape
    # normalise: ink ~0, paper ~1
    lo,hi=np.percentile(a,3),np.percentile(a,97); a=np.clip((a-lo)/max(.05,hi-lo),0,1)
    ink=1-a
    ops=[]
    # 1. stroke weight: erosion (thin/broken) or dilation (bleed/heavy)
    r=rng.random()
    if r<0.5:
        img=Image.fromarray((a*255).astype(np.uint8)).resize((w*2,h*2),Image.BILINEAR)
        img=img.filter(ImageFilter.MaxFilter(3) if r<0.25 else ImageFilter.MinFilter(3)).resize((w,h),Image.BILINEAR)
        a=np.asarray(img,np.float32)/255; ops.append('erode' if r<0.25 else 'dilate')
    # 2. ink bleed: blur then re-threshold softly (spreads ink)
    if rng.random()<0.35*strength:
        b=np.asarray(Image.fromarray((a*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(rng.uniform(0.6,1.2))),np.float32)/255
        t=rng.uniform(0.55,0.8); a=np.clip((b-t+0.5)*1.6+0.0,0,1)*0.6+b*0.4; ops.append('bleed')
    # 3. broken strokes: knock out ink with random small blobs (worn type)
    if rng.random()<0.55*strength:
        n=int(w*h/rng.uniform(500,1500))
        mask=_blob_field(h,w,n,0.7,1.6,rng)>0.6
        a=np.where(mask, np.maximum(a, rng.uniform(0.6,0.95)), a); ops.append('broken')
    # 4. speckle noise / ink dots
    if rng.random()<0.45*strength:
        sp=np.random.default_rng(rng.randrange(1<<30)).random((h,w))
        a=np.where(sp<rng.uniform(0.002,0.01),rng.uniform(0,0.4),a); a=np.where(sp>1-rng.uniform(0.002,0.01),1,a); ops.append('speckle')
    # 5. foxing: brown/dark blotches on paper
    if rng.random()<0.35*strength:
        f=_blob_field(h,w,rng.randint(1,4),h*0.3,h*1.2,rng)
        a=a*(1-f*rng.uniform(0.15,0.4)); ops.append('foxing')
    # 6. uneven light: gradient across the line
    if rng.random()<0.5*strength:
        gx=np.linspace(0,1,w)[None,:]; gy=np.linspace(0,1,h)[:,None]
        g=1-(rng.uniform(0.1,0.45))*(gx if rng.random()<.5 else 1-gx)*(0.6+0.4*gy)
        a=a*g; ops.append('light')
    # 7. low contrast / faded ink
    if rng.random()<0.35*strength:
        fl=rng.uniform(0.1,0.3); a=a*(1-fl)+fl; ops.append('faded')
    # 8. gaussian noise
    if rng.random()<0.5*strength:
        a=a+np.random.default_rng(rng.randrange(1<<30)).normal(0,rng.uniform(0.02,0.06),(h,w)); ops.append('noise')
    a=np.clip(a,0,1)
    img=Image.fromarray((a*255).astype(np.uint8))
    # 9. blur (out of focus scan)
    if rng.random()<0.35*strength:
        img=img.filter(ImageFilter.GaussianBlur(rng.uniform(0.3,0.8))); ops.append('blur')
    # 10. warp: sinusoidal vertical displacement (page curl)
    if rng.random()<0.35*strength:
        arr=np.asarray(img); amp=rng.uniform(0.6,2.0); per=rng.uniform(w*0.4,w*1.5); ph=rng.uniform(0,6.28)
        out=np.full_like(arr,int(np.median(arr)))
        for x in range(w):
            dy=int(round(amp*math.sin(2*math.pi*x/per+ph)))
            if dy>0: out[dy:,x]=arr[:-dy,x]
            elif dy<0: out[:dy,x]=arr[-dy:,x]
            else: out[:,x]=arr[:,x]
        img=Image.fromarray(out); ops.append('warp')
    # 11. skew
    if rng.random()<0.4*strength:
        ang=rng.uniform(-1.2,1.2); img=img.rotate(ang,resample=Image.BICUBIC,expand=False,fillcolor=int(np.median(np.asarray(img)))); ops.append('skew')
    # 12. JPEG-ish resample loss: down/up scale
    if rng.random()<0.3*strength:
        s=rng.uniform(0.6,0.85); img=img.resize((max(8,int(w*s)),max(8,int(h*s))),Image.BILINEAR).resize((w,h),Image.BILINEAR); ops.append('resample')
    return img, ops

def _extra(img, rng, ops):
    a=np.asarray(img,np.float32)/255.0; h,w=a.shape
    R=np.random.default_rng(rng.randrange(1<<30))
    # bleed-through: mirrored faint copy of text from the other side of the leaf
    if rng.random()<0.3:
        m=np.fliplr(a); dy=rng.randint(-h//3,h//3); m=np.roll(m,dy,axis=0); m=np.roll(m,rng.randint(0,w),axis=1)
        mb=np.asarray(Image.fromarray((m*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(rng.uniform(0.8,1.8))),np.float32)/255
        k=rng.uniform(0.12,0.3); a=np.minimum(a, 1-(1-mb)*k); ops.append('bleedthrough')
    # stains: big water/tea stain with darker tide-line edge
    if rng.random()<0.25:
        f=_blob_field(h,w,rng.randint(1,2),h*0.8,h*2.5,rng)
        edge=np.clip(1-np.abs(f-0.5)*6,0,1)
        a=a*(1-f*rng.uniform(0.08,0.25)-edge*rng.uniform(0.05,0.2)); ops.append('stain')
    # cracks / scratches through the type
    if rng.random()<0.25:
        for _ in range(rng.randint(1,4)):
            y=rng.randint(0,h-1); x0=rng.randint(0,w-1); L=rng.randint(w//8,w//2)
            a[max(0,y-1):y+1, x0:x0+L]=np.maximum(a[max(0,y-1):y+1, x0:x0+L], rng.uniform(.7,1.0))
        ops.append('scratch')
    # uneven stroke weight: half the line eroded/dilated
    if rng.random()<0.25:
        im2=Image.fromarray((a*255).astype(np.uint8)).filter(ImageFilter.MaxFilter(3) if rng.random()<.5 else ImageFilter.MinFilter(3))
        b=np.asarray(im2,np.float32)/255; g=np.linspace(0,1,w)[None,:]; g=g if rng.random()<.5 else 1-g
        a=a*(1-g)+b*g; ops.append('uneven_weight')
    # horizontal ink smear (press slur)
    if rng.random()<0.2:
        k=rng.randint(2,4); kern=np.ones(k)/k
        b=np.apply_along_axis(lambda r: np.convolve(r,kern,mode='same'),1,a); a=np.minimum(a,b*0.5+a*0.5); ops.append('slur')
    # yellowed / dark paper tone
    if rng.random()<0.3:
        a=a*rng.uniform(0.75,0.92); ops.append('paper_tone')
    # salt-and-pepper heavy noise
    if rng.random()<0.15:
        a=a+R.normal(0,rng.uniform(0.06,0.12),(h,w)); ops.append('heavy_noise')
    return Image.fromarray((np.clip(a,0,1)*255).astype(np.uint8))

def degrade(im, rng=None, strength=None):
    rng=rng or random.Random()
    s=strength if strength is not None else rng.uniform(0.5,1.4)
    for _ in range(4):
        img,ops=degrade_base(im,rng,min(1.25,s))
        img=_extra(img,rng,ops)
        if len(ops)>=2: break
    return img, ops
