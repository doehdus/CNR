"""Reproduce the approved fixed-noise power SS previews across two BPF datasets.
Usage: python generate_and_evaluate.py --bpf1 PATH --bpf2 PATH --experiment PATH --output PATH
Dependencies: numpy, scipy, pystoi==0.4.1. Original inputs are read-only.
"""
from pathlib import Path
import argparse,csv,json,hashlib,warnings,platform,zipfile
from collections import defaultdict
import numpy as np
import scipy
from scipy.io import wavfile
from scipy.signal import stft,istft,get_window,correlate,correlation_lags
from scipy.ndimage import convolve1d
from pystoi import stoi
import pystoi

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def load(p):
 rate,q=wavfile.read(p)
 assert rate==16000 and q.dtype==np.int16 and q.ndim==1,p
 return q.astype(np.float64)/32768.0

def write_csv(path,rows):
 with path.open('w',encoding='utf-8-sig',newline='') as f:
  w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)

def score(ref,target):
 with warnings.catch_warnings():
  warnings.simplefilter('error',RuntimeWarning)
  values=[float(stoi(ref,target,16000,extended=ext)) for ext in [False,True]]
 assert all(np.isfinite(v) and -1<=v<=1 for v in values)
 return values

def summarize(rows,keys):
 groups=defaultdict(list)
 for r in rows:groups[tuple(r[k] for k in keys)].append(r)
 result=[]
 for key,rs in sorted(groups.items()):
  item=dict(zip(keys,key));item['count']=len(rs)
  for metric in ['stoi','estoi']:
   vals=np.array([r[metric] for r in rs]);ds=np.array([r['delta_'+metric+'_vs_bpf'] for r in rs])
   item.update({metric+'_mean':float(vals.mean()),'bpf_'+metric+'_mean':float(np.mean([r['bpf_'+metric] for r in rs])), 'delta_'+metric+'_mean':float(ds.mean()),'delta_'+metric+'_min':float(ds.min()),'delta_'+metric+'_max':float(ds.max()),metric+'_increased':int(sum(ds>1e-10)),metric+'_decreased':int(sum(ds<-1e-10)),metric+'_unchanged':int(sum(abs(ds)<=1e-10))})
  result.append(item)
 return result

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--bpf1',type=Path,required=True);ap.add_argument('--bpf2',type=Path,required=True);ap.add_argument('--experiment',type=Path,required=True);ap.add_argument('--output',type=Path,required=True);args=ap.parse_args()
 assert pystoi.__version__=='0.4.1'
 out=args.output;out.mkdir(parents=True,exist_ok=True);(out/'metadata').mkdir(exist_ok=True)
 metadata_path=args.experiment/'outputs/mixture_preparation/tables/mixtures.csv'
 metadata={r['file']:r for r in csv.DictReader(metadata_path.open(encoding='utf-8-sig'))}
 settings={'alphas':[1,5],'beta':.02,'domain':'power','sample_rate_hz':16000,'frame_samples':512,'hop_samples':256,'window':'periodic Hann','noise_estimation_sec':[.05,.45],'noise_estimation_frames':24,'noise_update':False,'amplitude_gain_cap':1.,'frequency_gain_smoothing':[.25,.5,.25],'temporal_gain_smoothing':'G[t]=0.6*G[t-1]+0.4*G_current[t]; first frame unchanged','reconstruction':'scipy stft/istft; zero extension and padded; output trimmed to original sample count','PCM':'signed PCM16; round halves away from zero','extra_output_gain_db':0,'volume_normalization':False,'metric_library':'pystoi==0.4.1','metric_reference':'paired original Clean reference; same reference for BPF-only and both SS branches','metric_interval':'full common overlap after shared BPF-derived cross-correlation delay (search +/-0.5 s); not separate alignment optimization for SS candidates','versions':{'python':platform.python_version(),'numpy':np.__version__,'scipy':scipy.__version__,'pystoi':pystoi.__version__},'metadata_sha256':sha(metadata_path)}
 (out/'settings.json').write_text(json.dumps(settings,ensure_ascii=False,indent=2))
 w=get_window('hann',512,fftbins=True);rows=[];inputs=[];baselines=[]
 for number,folder in [(1,args.bpf1),(2,args.bpf2)]:
  matches=list(folder.rglob('result.json'));assert len(matches)==1
  manifest=matches[0];d=json.loads(manifest.read_text());assert len(d['conditions'])==144
  (out/'metadata'/f'butterworth{number}_source_result.json').write_text(manifest.read_text())
  for index,rec in enumerate(d['conditions'],1):
   rel=Path(rec['output']);source=manifest.parent/rel;assert sha(source)==rec['output_sha256']
   m=metadata['mixtures/'+rel.as_posix()];original=args.experiment/'mixtures'/rel
   assert sha(original)==rec['source_sha256']
   refpath=args.experiment/'data/reference'/f"{rec['statement']}.wav"
   x=load(source);ref=load(refpath)*float(m['common_gain_for_utterance']);assert len(ref)==len(x)
   assert float(m['snr_interval_start_sec'])>=.45
   prefix=x[800:7200];frames=np.stack([prefix[i:i+512] for i in range(0,len(prefix)-511,256)]);assert len(frames)==24
   N=np.mean(abs(np.fft.rfft(frames*w,axis=1)/sum(w))**2,axis=0)
   _,_,Y=stft(x,16000,window=w,nperseg=512,noverlap=256,nfft=512,boundary='zeros',padded=True);P=abs(Y)**2
   _,identity=istft(Y,16000,window=w,nperseg=512,noverlap=256,nfft=512,boundary=True);assert max(abs(identity[:len(x)]-x))<1e-10
   corr=correlate(x-x.mean(),ref-ref.mean(),method='fft');lags=correlation_lags(len(x),len(ref));mask=abs(lags)<=8000;delay=int(lags[mask][np.argmax(abs(corr[mask]))])
   a=max(0,-delay);b=max(0,delay);length=min(len(ref)-a,len(x)-b);r=ref[a:a+length]
   bpf_stoi,bpf_estoi=score(r,x[b:b+length])
   common={'bpf':f'butterworth{number}','noise':rec['noise'],'snr_db':rec['snr_db'],'statement':rec['statement'],'speaker':m['speaker'],'alignment_delay_samples':delay,'compared_samples':length}
   baselines.append({**common,'stoi':bpf_stoi,'estoi':bpf_estoi})
   inputs.append({**common,'bpf_file':str(source.resolve()),'bpf_sha256':sha(source),'mixture_sha256':sha(original),'reference_file':str(refpath.resolve()),'reference_sha256':sha(refpath),'source_sample_count':len(x),'source_gain_db':d['candidate']['output_gain_db']})
   for alpha in [1,5]:
    G=np.minimum(np.sqrt(np.maximum(P-alpha*N[:,None],.02*N[:,None])/np.maximum(P,1e-30)),1.)
    G=convolve1d(G,np.array([.25,.5,.25]),axis=0,mode='nearest')
    for k in range(1,G.shape[1]):G[:,k]=.6*G[:,k-1]+.4*G[:,k]
    _,z=istft(G*Y,16000,window=w,nperseg=512,noverlap=256,nfft=512,boundary=True);z=z[:len(x)]
    assert np.isfinite(z).all() and max(abs(z))<1,(source,alpha,'clipping')
    q=(np.sign(z)*np.floor(abs(z)*32768+.5)).astype(np.int16)
    dest=out/'audio'/f'butterworth{number}'/f'ss_alpha{alpha}'/rel;dest.parent.mkdir(parents=True,exist_ok=True);wavfile.write(dest,16000,q)
    saved=load(dest);assert len(saved)==len(x)
    sv,ev=score(r,saved[b:b+length])
    rows.append({**common,'alpha':alpha,'stoi':sv,'estoi':ev,'bpf_stoi':bpf_stoi,'bpf_estoi':bpf_estoi,'delta_stoi_vs_bpf':sv-bpf_stoi,'delta_estoi_vs_bpf':ev-bpf_estoi,'audio':str(dest.relative_to(out)),'audio_sha256':sha(dest),'peak_dbfs':float(20*np.log10(max(abs(saved)))),'clipped_samples':int(sum(abs(saved)>=1))})
   if index%24==0:print(f'Butterworth {number}: {index}/144 inputs, {len(rows)}/576 SS files',flush=True)
 assert len(rows)==576 and len(inputs)==288 and len(list((out/'audio').rglob('*.wav')))==576
 write_csv(out/'metrics_576.csv',rows);write_csv(out/'baseline_butterworth_288.csv',baselines);write_csv(out/'input_manifest_288.csv',inputs)
 summary=summarize(rows,['bpf','alpha']);write_csv(out/'summary_overall.csv',summary);write_csv(out/'summary_noise_snr.csv',summarize(rows,['bpf','alpha','noise','snr_db']))
 report={'expected_files':576,'actual_files':len(rows),'baseline_scores':len(baselines),'all_source_hashes_verified':True,'all_wav_headers_and_sample_counts_verified':True,'clipped_samples':sum(r['clipped_samples'] for r in rows),'metric_failures':0,'alignment_delay_range_samples':[min(r['alignment_delay_samples'] for r in rows),max(r['alignment_delay_samples'] for r in rows)],'overall':summary}
 (out/'validation_and_summary.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
 readme='''고정형 SS 감산 1·5 전체 처리 및 STOI·ESTOI 계산 결과\n\n입력: Butterworth 1·2 각각 144개. 출력: 2필터 × 2SS × 144조건 = 576 WAV.\n각 144조건: 12문장 × 단일·복합·변화 소음 × 입력 SNR 20·10·5·0dB.\n입력 SNR 폴더명은 원래 합성 조건이며, 처리 후 달성 SNR을 뜻하지 않습니다.\n\naudio/butterworth1 또는 butterworth2/ss_alpha1 또는 ss_alpha5/소음/snrXX/문장.wav\n\n바닥값 0.02, 32ms/16ms 프레임, 0.05~0.45초의 24프레임 평균 소음 전력을 고정.\n진폭 이득 상한1, 주파수 평활 [.25,.5,.25], 시간 평활 0.6이전+0.4현재.\n두 SS 후보는 감산 강도만 다릅니다. 예비 청취에 사용한 평활화 처리와 동일합니다.\n음량 보정 전 WAV이며, 원본 Butterworth에 포함된 -1.7dB 외 추가 정규화/증폭은 없습니다.\n\nmetrics_576.csv: 전체 점수·Butterworth 대비 변화량·파일 해시.\nbaseline_butterworth_288.csv: 필터만 적용한 기준 점수.\nsummary_overall.csv: 144조건에 같은 가중치를 준 네 조합의 평균 및 상승·하락 수.\nsummary_noise_snr.csv: 소음·입력 SNR별 12문장 평균.\nsettings.json: 처리·계산 설정. input_manifest_288.csv: 입력 대응·해시.\nvalidation_and_summary.json: 생성 수량·클리핑·검증 및 평균.\ncode/generate_and_evaluate.py: 입력 경로를 지정해 재현 가능한 처리·평가 코드.\n\n계산: pystoi 0.4.1, 동일한 대응 Clean, 전체 공통 겹침 구간.\n각 Butterworth 입력에서 얻은 교차상관 지연을 필터 단독·SS1·SS5에 공통 적용했습니다.\nSTOI·ESTOI는 명료도 예측 점수이며 실제 정답률·자연스러움 점수가 아닙니다.\n후보 탐색에 사용한 데이터에서의 기술통계이며 독립 검증/통계적 유의성 검정은 아닙니다.\n원본 입력 및 프로젝트 저장소는 수정하지 않았습니다.\n'''
 (out/'README.txt').write_text(readme)
 archive=out.parent/'fixed_ss_20261125_audio_and_metrics.zip'
 with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=5) as z:
  for f in sorted(out.rglob('*')):
   if f.is_file():z.write(f,Path(out.name)/f.relative_to(out))
 print('FINISHED',json.dumps(report,ensure_ascii=False),flush=True)
 print('ARCHIVE',str(archive),archive.stat().st_size,flush=True)
if __name__=='__main__':main()
