"""Plot saved C candidate evidence; no DSP or numerical averaging."""
import csv
from pathlib import Path

from analysis.mkgraphs.plot_research import plt
from analysis.mkgraphs.run_research import read, digest, safe


def rows(path):
    with path.open(encoding='utf-8',newline='') as stream:return list(csv.DictReader(stream))


def render(root,stage,config):
    scan=config['scan_evidence'];manifest_path=safe(root,scan['manifest'])
    if digest(manifest_path)!=scan['sha256']:raise ValueError('Candidate scan changed.')
    manifest=read(manifest_path);source=manifest_path.parent
    for name in ('metrics.csv','ranking.csv'):
        if digest(source/name)!=manifest['artifacts'][name]['sha256']:raise ValueError('Scan evidence changed.')
    scan_metrics={r['candidate_id']:r for r in rows(source/'metrics.csv')}
    ranking=rows(source/'ranking.csv');measured=rows(stage/'metrics.csv');response=rows(stage/'responses.csv')
    selected=[r for r in measured if r['candidate_id']!='bypass']
    labels=config['plot_labels'];palette=plt.get_cmap('tab10');graphs=[]
    directory=stage/'graphs';directory.mkdir()
    def save(fig,identity,folder,title):
        fig.suptitle(title,fontsize=14);fig.tight_layout(rect=(0,.06,1,.94))
        fig.text(.5,.015,'Saved C predictions; single pass, registered intervals. Not STOI/ESTOI or post-algorithm performance.',ha='center',fontsize=9)
        path=directory/(identity+'.png');fig.savefig(path,dpi=160);plt.close(fig)
        graphs.append({'id':identity,'folder':folder,'path':'graphs/'+path.name,'sha256':digest(path),'size':path.stat().st_size})
    fig,axes=plt.subplots(1,2,figsize=(15,6))
    axes[0].scatter([100-float(scan_metrics[r['candidate_id']]['clean_min_percent']) for r in ranking],
                    [float(r['mean_noise_reduction_db']) for r in ranking],s=5,color='#6f8d9e',alpha=.14)
    axes[1].scatter([float(r['worst_speech_loss_metric_percent']) for r in ranking],
                    [float(r['mean_noise_reduction_db']) for r in ranking],s=5,color='#6f8d9e',alpha=.14)
    for i,m in enumerate(selected):
        loss=next(r for r in ranking if r['candidate_id']==m['candidate_id'])
        axes[0].scatter(100-float(m['clean_min_percent']),float(m['noise_mean_db']),color=palette(i),s=70,label=labels[m['candidate_id']],edgecolors='white')
        axes[1].scatter(float(loss['worst_speech_loss_metric_percent']),float(m['noise_mean_db']),color=palette(i),s=70,edgecolors='white')
    axes[0].set(xlabel='Worst-recording total Clean power loss (%)',ylabel='Mean noise power reduction (dB)',title='Total power alone can hide high-band speech loss',xlim=(0,100))
    axes[1].set(xlabel='Worst loss across total, 2-4 kHz, 4-8 kHz Clean (%)',ylabel='Mean noise power reduction (dB)',title='Speech-band-aware view (zoom)',xlim=(0,7),ylim=(0,.6))
    axes[0].legend(fontsize=8,loc='upper right')
    for axis in axes:axis.grid(alpha=.2)
    save(fig,'B1_tradeoff','09_Butterworth_음성보존_소음감소_비교','Butterworth · voice preservation and noise reduction')
    fig,axes=plt.subplots(1,3,figsize=(18,6))
    for i,m in enumerate(selected):
        curve=[r for r in response if r['candidate_id']==m['candidate_id']]
        x=[float(r['frequency_hz']) for r in curve];y=[float(r['gain_db']) if r['gain_db'] else float('nan') for r in curve]
        for axis in axes:axis.plot(x,y,color=palette(i),label=labels[m['candidate_id']],linewidth=1.2)
    for axis,limits,title in zip(axes,[(0,8000),(0,250),(7600,8000)],['Full spectrum','Lower edge','Upper edge']):
        axis.set(xlim=limits,ylim=(-60,3),xlabel='Frequency (Hz)',ylabel='Single-pass gain (dB)',title=title);axis.axhline(-3.01029995664,color='#888',linestyle=':',linewidth=.8);axis.grid(alpha=.2)
    axes[0].legend(fontsize=8,loc='lower center')
    save(fig,'B2_response','10_Butterworth_후보_주파수응답','Butterworth · exact candidate power responses')
    fig,axes=plt.subplots(1,2,figsize=(15,6))
    width=.8/max(1,len(selected))
    for i,m in enumerate(selected):
        axes[0].bar([j-.4+width*(i+.5) for j in range(3)],[float(m[k+'_snr_db']) for k in ('single','complex','changing')],width=width,color=palette(i),label=labels[m['candidate_id']])
        axes[1].scatter(float(m['clean_min_percent']),float(m['clean_4_8k_min_percent']),color=palette(i),s=70)
    axes[0].set(xticks=[0,1,2],xticklabels=['Single','Complex','Changing'],ylabel='Predicted SNR change (dB)',title='48 paired conditions per noise');axes[0].legend(fontsize=8)
    axes[1].set(xlabel='Worst total Clean power retained (%)',ylabel='Worst 4-8 kHz Clean power retained (%)',title='Total and weak-band preservation are different',xlim=(90,100.5),ylim=(0,103))
    for axis in axes:axis.grid(alpha=.2)
    save(fig,'B3_effect','11_Butterworth_소음별_예상_SNR_변화','Butterworth · per-noise SNR and speech preservation')
    return graphs
