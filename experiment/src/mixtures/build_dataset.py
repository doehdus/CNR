"""Reproduce the 2026-11-18 mixture batch and supplementary Python spectra.

Existing C FFT outputs and original recordings are never replaced.
Peak settings reproduce this exploratory batch, not an agreed filter design.
"""
from pathlib import Path
import numpy as np, wave, json, csv, hashlib, shutil, zipfile
from scipy.signal import resample_poly, welch, find_peaks, peak_widths
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager


def main():
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    experiment=Path(__file__).resolve().parents[2]
    parser.add_argument('--clean-root',type=Path,default=experiment/'data/clean')
    parser.add_argument('--noise-root',type=Path,default=experiment/'data/noise')
    parser.add_argument('--output',type=Path,required=True,help='New empty output directory; contains an experiment-compatible tree.')
    args=parser.parse_args()
    ROOT=args.output.resolve(); CLEAN=args.clean_root.resolve(); NOISE=args.noise_root.resolve()
    if ROOT.exists() and any(ROOT.iterdir()):parser.error('Output must be empty; existing results are preserved.')
    expected={f'{kind}{i:02d}.wav' for kind in ['instruction','warning'] for i in range(1,7)}
    if {p.name for p in CLEAN.glob('*.wav')}!=expected:parser.error('Expected instruction01–06 and warning01–06.')
    if not all((NOISE/(t+'.wav')).is_file() for t in ['single','complex','changing']):parser.error('Three noise originals are required.')
    if any(ROOT==p or ROOT in p.parents or p in ROOT.parents for p in [CLEAN,NOISE]):parser.error('Output must be separate from input directories.')
    FS=16000; SNRS=[0,5,10,20]; TYPES=['single','complex','changing']
    LABEL={'single':'단일: 콘크리트 절단기 B','complex':'복합: 절단기 B + 드릴','changing':'변화: 2.5초부터 드릴 추가'}
    COL={'single':'#243a52','complex':'#3267dc','changing':'#9096a4'}
    for folder in ['data/reference','outputs/mixture_preparation/noise','mixtures','outputs/graphs/mixture_analysis','outputs/mixture_analysis/tables']: (ROOT/folder).mkdir(parents=True,exist_ok=True)
    font=next((p for p in [Path('/System/Library/Fonts/AppleSDGothicNeo.ttc'),Path('C:/Windows/Fonts/malgun.ttf'),Path('/usr/share/fonts/truetype/nanum/NanumGothic.ttf')] if p.exists()),Path('/nonexistent-font'))
    if font.exists():
     font_manager.fontManager.addfont(str(font));plt.rcParams['font.family']=font_manager.FontProperties(fname=str(font)).get_name()
    plt.rcParams.update({'axes.unicode_minus':False,'font.size':11,'axes.spines.top':False,'axes.spines.right':False,'figure.facecolor':'white','axes.grid':True,'grid.alpha':.18})
    def read(p):
     with wave.open(str(p)) as w:
      assert w.getsampwidth()==2
      sr=w.getframerate();ch=w.getnchannels();x=np.frombuffer(w.readframes(w.getnframes()),'<i2').astype(float).reshape(-1,ch).mean(axis=1)/32768
     return (resample_poly(x,FS,sr) if sr!=FS else x),sr
    def write(p,x):
     p.parent.mkdir(parents=True,exist_ok=True)
     a=np.rint(x*32768)
     assert a.min()>=-32768 and a.max()<=32767
     with wave.open(str(p),'wb') as w:w.setparams((1,2,FS,0,'NONE','not compressed'));w.writeframes(a.astype('<i2').tobytes())
     return a/32768
    def table(name,rows):
     with (ROOT/'outputs/mixture_analysis/tables'/name).open('w',encoding='utf-8-sig',newline='') as h:
      c=csv.DictWriter(h,fieldnames=list(rows[0]));c.writeheader();c.writerows(rows)
    def db(x):return 10*np.log10(np.maximum(x,1e-16))
    def psd(x):return welch(x,FS,window='hann',nperseg=2048,noverlap=1024,detrend='constant',scaling='density')
    def active(x):
     # Energy-based start/end estimate, not linguistic VAD; preserve internal pauses.
     hop=160;win=320;starts=np.arange(0,len(x)-win+1,hop)
     rms=np.array([np.sqrt(np.mean(x[s:s+win]**2)) for s in starts])
     threshold=max(float(np.percentile(rms,20))*5,float(rms.max())*.04,10**(-50/20))
     mask=rms>threshold
     for group in np.split(np.where(mask)[0],np.where(np.diff(np.where(mask)[0])>1)[0]+1):
      if len(group)<3:mask[group]=False
     ids=np.where(mask)[0];assert len(ids)>0
     a=max(0,int(starts[ids[0]])-800);b=min(len(x),int(starts[ids[-1]])+win+800)
     return a,b,threshold
    voices={};intervals={};info=[]
    for p in sorted([*CLEAN.glob('*.wav'), *NOISE.glob('*.wav')], key=lambda p: p.name):
     x,sr=read(p)
     info.append({'file':p.name,'original_sample_rate':sr,'seconds':len(x)/FS,'peak_dbfs':float(db(max(x*x))),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
     if p.stem not in TYPES:
      voices[p.stem]=x;intervals[p.stem]=active(x)
    assert len(voices)==12
    noises={t:read(NOISE/(t+'.wav'))[0] for t in TYPES}
    original_noise_length=min(map(len,noises.values()))
    maxlen=max(map(len,voices.values()))
    def extend(x,n):
     if len(x)>=n:return x[:n].copy()
     # Crossfade a 1 s tail loop; never restart the original 2.5 s transition.
     y=x.copy();fade=320;tail=x[-16000:]
     while len(y)<n:
      ramp=np.linspace(0,1,fade)
      join=y[-fade:]*(1-ramp)+tail[:fade]*ramp
      y=np.r_[y[:-fade],join,tail[fade:]]
     return y[:n]
    for t in TYPES:noises[t]=extend(noises[t],maxlen);write(ROOT/'outputs/mixture_preparation/noise'/(t+'.wav'),noises[t])

    fig,axes=plt.subplots(6,2,figsize=(14,17),sharex=True)
    for ax,(name,x) in zip(axes.flat,voices.items()):
     a,b,thr=intervals[name];ax.plot(np.arange(len(x))/FS,x,lw=.5,color='#3267dc');ax.axvspan(a/FS,b/FS,alpha=.12,color='green');ax.set_title(f'{name} | SNR 산정 구간 {a/FS:.2f}–{b/FS:.2f}s');ax.set_ylim(-1,1)
    for ax in axes[-1]:ax.set_xlabel('시간 (s)')
    fig.suptitle('말소리 구간 추정 확인 — 초록 구간으로 SNR 계산 (음원은 자르지 않음)',fontsize=17);fig.tight_layout(rect=[0,0,1,.97]);fig.savefig(ROOT/'outputs/graphs/mixture_analysis/01_음성구간_확인.png',dpi=160);plt.close(fig)

    mixes={}; rows=[]; checks=[];mixnoise={}
    for name,x in voices.items():
     a,b,thr=intervals[name];sp=np.mean(x[a:b]**2);plans=[]
     for t in TYPES:
      n=noises[t][:len(x)];nr=np.sqrt(np.mean(n[a:b]**2))
      for snr in SNRS:
       factor=np.sqrt(sp)/(nr*10**(snr/20));plans.append((t,snr,n*factor,factor))
     peak=max(np.max(np.abs(x+n)) for t,s,n,f in plans)
     gain=min(1.,.95/peak)
     clean=write(ROOT/'data/reference'/(name+'.wav'),x*gain)
     for t,snr,n,factor in plans:
      # Rounded clean + rounded noise sum is exactly the stored mixture.
      nq=np.rint(n*gain*32768)/32768;y=clean+nq
      path=ROOT/'mixtures'/t/f'snr{snr:02d}'/(name+'.wav');saved=write(path,y)
      actual=10*np.log10(np.mean(clean[a:b]**2)/np.mean(nq[a:b]**2))
      assert abs(actual-snr)<.015
      assert np.array_equal(saved,clean+nq)
      mixes[t,snr,name]=saved;mixnoise[t,snr,name]=nq
      rows.append({'file':str(path.relative_to(ROOT)),'speaker':'유채원' if int(name[-2:])<=3 else '김도연','noise':t,'snr_target_db':snr,'snr_measured_db':round(float(actual),6),'duration_sec':len(x)/FS,'snr_interval_start_sec':a/FS,'snr_interval_end_sec':b/FS,'interval_method':'20ms RMS/10ms hop; >=3-frame runs; 50ms margin; includes internal pauses','threshold_rms':thr,'noise_scale':factor,'common_gain_for_utterance':gain,'peak_dbfs':round(float(db(max(saved*saved))),3),'clipped_samples':int(np.sum(abs(saved)>=1)),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    table('01_원본정보.csv',info);table('02_합성목록_검증.csv',rows)

    peakrows=[];bandrows=[];spectra={};bands=[(0,100),(100,300),(300,1000),(1000,2000),(2000,4000),(4000,8001)]
    for t in TYPES:
     original=read(NOISE/(t+'.wav'))[0];f,p=psd(original);spectra[t]=(f,p)
     pd=db(p);idx,prop=find_peaks(pd,prominence=6,distance=6)
     idx=idx[np.argsort(p[idx])[::-1]][:8]
     for rank,i in enumerate(idx,1):
      width=peak_widths(p,[i],rel_height=.5)[0][0]*(f[1]-f[0])
      peakrows.append({'noise':t,'rank_by_power':rank,'frequency_hz':round(float(f[i]),2),'psd_dbfs_per_hz':round(float(pd[i]),2),'half_prominence_width_hz_approx':round(float(width),2)})
     for lo,hi in bands:bandrows.append({'noise':t,'band_hz':f'{lo}-{min(hi,8000)}','energy_percent':round(float(p[(f>=lo)&(f<hi)].sum()/p.sum()*100),3)})
    table('03_소음_주요피크.csv',peakrows);table('04_소음_대역별에너지.csv',bandrows)

    fig,axes=plt.subplots(3,1,figsize=(13,10),sharex=True,sharey=True)
    for ax,t in zip(axes,TYPES):
     x=read(NOISE/(t+'.wav'))[0];w=np.hanning(len(x));f=np.fft.rfftfreq(len(x),1/FS);mag=2*np.abs(np.fft.rfft((x-x.mean())*w))/w.sum()
     ax.plot(f,20*np.log10(np.maximum(mag,1e-8)),color=COL[t],lw=.5);ax.set_title(LABEL[t]);ax.set_ylabel('진폭 (dBFS)');ax.set_ylim(-110,0);ax.set_xlim(0,8000)
    axes[-1].set_xlabel('주파수 (Hz)');fig.suptitle('소음 원본 전체 구간 FFT — 동일한 축, Hann 창 적용',fontsize=17);fig.tight_layout(rect=[0,0,1,.96]);fig.savefig(ROOT/'outputs/graphs/mixture_analysis/02_소음원본_전체FFT.png',dpi=180);plt.close(fig)
    fig,axes=plt.subplots(3,1,figsize=(13,10),sharex=True,sharey=True)
    for ax,t in zip(axes,TYPES):
     f,p=spectra[t];ax.plot(f,db(p),color=COL[t]);ax.set_title(LABEL[t]);ax.set_ylabel('PSD (dBFS/Hz)');ax.set_xlim(0,8000);ax.set_ylim(-105,-15)
     for r in [r for r in peakrows if r['noise']==t][:3]:
      hz=r['frequency_hz'];v=r['psd_dbfs_per_hz'];ax.annotate(f'{hz:.0f} Hz',(hz,v),xytext=(8,8),textcoords='offset points',fontsize=9)
    axes[-1].set_xlabel('주파수 (Hz)');fig.suptitle('소음 주파수 에너지와 주요 피크 — Welch PSD, 주파수 간격 7.8125 Hz',fontsize=17);fig.tight_layout(rect=[0,0,1,.96]);fig.savefig(ROOT/'outputs/graphs/mixture_analysis/03_소음원본_피크.png',dpi=180);plt.close(fig)

    mixpeaks=[]
    for t in TYPES:
     fig,axes=plt.subplots(2,2,figsize=(14,9),sharex=True,sharey=True)
     for ax,snr in zip(axes.flat,SNRS):
      data=np.array([psd(mixes[t,snr,name])[1] for name in voices]);npow=np.array([psd(mixnoise[t,snr,name])[1] for name in voices])
      f=np.fft.rfftfreq(2048,1/FS);mean=data.mean(axis=0)
      ax.fill_between(f,db(data.min(axis=0)),db(data.max(axis=0)),alpha=.12,color=COL[t],label='12문장 범위')
      ax.plot(f,db(mean),color=COL[t],label='합성음 12문장 평균');ax.plot(f,db(npow.mean(axis=0)),color='#d78322',ls='--',lw=1,label='합성에 사용한 소음 평균')
      ax.set_title(f'SNR {snr} dB');ax.set_xlim(0,8000);ax.set_ylim(-110,-15);ax.set_xlabel('주파수 (Hz)');ax.set_ylabel('PSD (dBFS/Hz)');ax.legend(fontsize=8)
      idx,_=find_peaks(db(mean),prominence=6,distance=6);idx=idx[np.argsort(mean[idx])[::-1]][:5]
      for i in idx:mixpeaks.append({'noise':t,'snr_db':snr,'frequency_hz':float(f[i]),'mean_psd_dbfs_per_hz':float(db(mean[i]))})
     fig.suptitle(LABEL[t]+' | 합성음의 주파수 분포 (문장별 공통 이득 적용)',fontsize=16);fig.tight_layout(rect=[0,0,1,.96]);fig.savefig(ROOT/f'outputs/graphs/mixture_analysis/04_{t}_합성음_주파수.png',dpi=180);plt.close(fig)
    table('05_합성음평균_피크.csv',mixpeaks)
    fig,axes=plt.subplots(1,2,figsize=(14,5),sharex=True,sharey=True)
    x=read(NOISE/'changing.wav')[0]
    for ax,(a,b,title) in zip(axes,[(0,40000,'0–2.5초: 절단기 B'),(40000,len(x),'2.5초 이후: 드릴 추가')]):
     f,p=psd(x[a:b]);ax.plot(f,db(p),color=COL['changing']);ax.set_title(title);ax.set_xlim(0,8000);ax.set_ylim(-105,-15);ax.set_xlabel('주파수 (Hz)');ax.set_ylabel('PSD (dBFS/Hz)')
    fig.suptitle('변화 소음 — 전체 평균에 가려지는 시간 변화 확인',fontsize=16);fig.tight_layout(rect=[0,0,1,.92]);fig.savefig(ROOT/'outputs/graphs/mixture_analysis/05_변화소음_2.5초전후.png',dpi=180);plt.close(fig)

    summary={'mixtures':len(rows),'max_snr_error_db':max(abs(r['snr_measured_db']-r['snr_target_db']) for r in rows),'clipped_samples':sum(r['clipped_samples'] for r in rows),'voices':12,'noises':3,'format':'16000Hz mono signed 16-bit PCM WAV','extension_max_sec':max(0,(maxlen-original_noise_length)/FS),'noise_peaks':peakrows,'band_energy':bandrows}
    errors=[]
    for row in rows:
     saved,_=read(ROOT/row['file'])
     reference,_=read(ROOT/'data/reference'/Path(row['file']).name)
     a=round(row['snr_interval_start_sec']*FS); b=round(row['snr_interval_end_sec']*FS)
     residual=saved-reference
     measured=float(10*np.log10(np.mean(reference[a:b]**2)/np.mean(residual[a:b]**2)))
     errors.append(abs(measured-row['snr_target_db']))
     if errors[-1]>=.015:raise ValueError('Stored-file SNR verification failed: '+row['file'])
     if len(saved)!=len(reference) or np.max(np.abs(saved))>=1:raise ValueError('Invalid stored audio: '+row['file'])
    summary['independent_readback_verified']=True
    summary['max_readback_snr_error_db']=max(errors)
    summary['input_hashes']={r['file']:r['sha256'] for r in info}
    summary['numpy_version']=np.__version__
    summary['scipy_version']=__import__('scipy').__version__
    summary['method']='2026-11-18 exploratory Python Welch analysis; existing C FFT unchanged'
    summary['reference_directory']='data/reference'
    summary['filter_validation_status']='not_performed'
    (ROOT/'outputs/mixture_analysis/verification.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(summary,ensure_ascii=False,indent=2))


if __name__ == "__main__":
    main()
