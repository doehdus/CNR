"""Compare common Butterworth settings with the completed research PSDs.

C owns numerical evidence. Python validates inputs, transports linear spectra
and preserves runs. This does not generate WAVs or select downstream settings.
"""
import argparse
import csv
from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid

from analysis.mkgraphs.run_research import ROOT, digest, packed, read, safe

CODE = Path(__file__).with_suffix('.c')
NOISES = ('single', 'complex', 'changing')


def evidence(root=ROOT):
    pointer = read(root/'analysis/results/signals/latest.json')
    manifest_path = safe(root,pointer['manifest'])
    if digest(manifest_path) != pointer['sha256']:
        raise ValueError('Analysis manifest changed.')
    manifest=read(manifest_path);run=manifest_path.parent; sources=[]

    def load(relative):
        path=safe(run,relative);record=manifest['artifacts'][relative]
        if digest(path)!=record['sha256']:
            raise ValueError('Completed analysis artifact changed: '+relative)
        sources.append({'path':path.relative_to(root).as_posix(),'sha256':record['sha256']})
        with (gzip.open(path,'rt',encoding='utf-8') if path.suffix=='.gz' else path.open(encoding='utf-8')) as stream:
            return json.load(stream)

    results=load('results.json')
    for row in results['inputs']:
        path=safe(root,row['source'])
        if digest(path)!=row['sha256']:
            raise ValueError('Original input changed: '+row['path'])
    rows=[];clean={}
    def case(identity,kind,noise,mix,speech,added):
        rows.append({'id':identity,'kind':kind,'noise':noise,'arrays':[mix,speech,added]})
    zeros=[0.]*1025
    for recording in results['recordings']:
        identity=recording['id'];data=load(f'clean/{identity}/spectral.json.gz');clean[identity]=data
        values=data['signal']['primary']['psd'];case('clean_'+identity,0,0,values,values,zeros)
    for number,noise in enumerate(NOISES,1):
        data=load(f'noise/{noise}/spectral.json.gz')
        for period in ('whole','before','after') if noise=='changing' else ('whole',):
            values=data['signal'][period]['psd'];case('noise_'+noise+'_'+period,1,number,values,zeros,values)
        for snr in (20,10,5,0):
            for recording in results['recordings']:
                identity=recording['id'];data=load(f'mixture/{noise}/snr{snr:02d}/{identity}/spectral.json.gz')
                for period,kind in [('primary',2),('whole',3)]:
                    case(f'{noise}_snr{snr:02d}_{identity}_{period}',kind,number,data['signal'][period]['psd'],clean[identity]['signal'][period]['psd'],data['added_noise'][period]['psd'])
    return rows, {'analysis':pointer,'sources':sources,'input_count':len(results['inputs']),
                  'recording_count':len(results['recordings']),'primary_conditions':144,'whole_conditions':144}


def transport(path,candidates,cases):
    with path.open('x',encoding='ascii',newline='\n') as stream:
        stream.write(f'CNR_BPF_RESEARCH_1 16000 1025 {len(candidates)} {len(cases)}\n')
        stream.write(' '.join(format(k*16000/2048,'.17g') for k in range(1025))+'\n')
        for c in candidates:
            stream.write(f"{c['id']} {c['type']} {c['lower_hz']} {c['upper_hz']} {c['prototype_order']}\n")
        for row in cases:
            stream.write(f"{row['id']} {row['kind']} {row['noise']}\n")
            for values in row['arrays']:
                stream.write(' '.join(format(value,'.17g') for value in values)+'\n')


def run(config,root=ROOT):
    if not set(config.get('screened_top_two',[])).issubset({c['id'] for c in config['candidates']}):
        raise ValueError('The comparison must contain both screened candidates.')
    root=Path(root).resolve();cases,provenance=evidence(root)
    rank_code=CODE.with_name('rank_research_bpf.c')
    code_paths={'runner':Path(__file__),'c_engine':CODE,'shared_c_response':CODE.with_name('compare_bpf.c'),'c_ranking':rank_code}
    source_hashes={key:digest(path) for key,path in code_paths.items()}
    if config.get('render_comparison'):
        code_paths['plotter']=CODE.with_name('plot_research_bpf.py')
        source_hashes['plotter']=digest(code_paths['plotter'])
    cache=root/'.cache/noise_analysis';cache.mkdir(parents=True,exist_ok=True)
    stage=Path(tempfile.mkdtemp(prefix='bpf-research-',dir=cache))
    try:
        executable=cache/'research_bpf.exe'
        subprocess.run([str(root/'.tools/tcc/tcc.exe'),'-std=c99','-Wall','-Werror',str(CODE),'-o',str(executable)],check=True)
        candidates=config['candidates'];input_path=stage/'input.txt'
        transport(input_path,candidates,cases)
        command=[str(executable),str(input_path),str(stage/'descriptors.csv'),str(stage/'metrics.csv'),str(stage/'cases.csv')]
        if len(candidates)<=16:command.append(str(stage/'responses.csv'))
        subprocess.run(command,check=True)
        if len(candidates)>1 and config.get('calculate_ranking',True):
            rank_executable=cache/'rank_research_bpf.exe'
            subprocess.run([str(root/'.tools/tcc/tcc.exe'),'-std=c99','-Wall','-Werror',str(rank_code),'-o',str(rank_executable)],check=True)
            subprocess.run([str(rank_executable),str(stage/'metrics.csv'),str(stage/'ranking.csv')],check=True)
        with input_path.open('rb') as src,gzip.open(stage/'input.txt.gz','wb') as dst:
            shutil.copyfileobj(src,dst)
        input_path.unlink()
        (stage/'settings.json').write_bytes(packed(config))
        (stage/'evidence.json').write_bytes(packed(provenance))
        if config.get('independent_verification'):
            verification=config['independent_verification']
            path=safe(root,verification['path']) if verification.get('path') and not verification['path'].startswith('.') else safe(root/'.cache/noise_analysis',verification['cache_file'])
            if digest(path)!=verification['sha256']:raise ValueError('Independent verification changed.')
            shutil.copy2(path,stage/'independent_verification.json')
        if config.get('render_comparison'):
            from .plot_research_bpf import render
            graphs=render(root,stage,config)
            (stage/'graphs.json').write_bytes(packed(graphs))
        if source_hashes!={key:digest(path) for key,path in code_paths.items()}:
            raise ValueError('Source code changed during this calculation.')
        run_id=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:8]
        manifest={'version':1,'run_id':run_id,'status':'completed_exploratory_not_final_audio',
                  'actual_counts':{'candidates':len(candidates),'clean':12,'raw_noise_periods':5,'primary_conditions':144,'whole_conditions':144,'new_wavs':0,'stoi_estoi_values':0},
                  'source_analysis':provenance['analysis'],
                  'sources':source_hashes,
                  'artifacts':{path.relative_to(stage).as_posix():{'sha256':digest(path),'size':path.stat().st_size} for path in stage.rglob('*') if path.is_file()}}
        (stage/'manifest.json').write_bytes(packed(manifest))
        parent=root/'analysis/results/candidates/butterworth';parent.mkdir(parents=True,exist_ok=True)
        target=parent/run_id
        stage.rename(target)
        pointer={'version':1,'run_id':run_id,'manifest':(target/'manifest.json').relative_to(root).as_posix(),'sha256':digest(target/'manifest.json')}
        latest=parent/('latest-'+uuid.uuid4().hex+'.tmp');latest.write_bytes(packed(pointer));latest.replace(parent/'latest.json')
        if config.get('render_comparison'):
            graph_root=root/'analysis/graphs';published=[]
            for graph in graphs:
                relative=f"analysis/graphs/{graph['folder']}/{run_id}/{graph['id']}.png"
                destination=safe(root,relative,exists=False);destination.parent.mkdir(parents=True,exist_ok=True)
                if destination.exists():raise ValueError('Graph destination exists.')
                shutil.copy2(target/graph['path'],destination)
                if digest(destination)!=graph['sha256']:raise ValueError('Graph copy differs.')
                published.append({**graph,'path':relative})
            index={'version':1,'source_candidate_run':pointer,'graphs':published}
            temporary=graph_root/('butterworth-'+uuid.uuid4().hex+'.tmp');temporary.write_bytes(packed(index));temporary.replace(graph_root/'butterworth_latest.json')
        return target
    finally:
        if stage.exists():
            if stage.resolve().parent!=cache.resolve():raise ValueError('Unsafe staging cleanup.')
            shutil.rmtree(stage)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--config',type=Path)
    args=parser.parse_args()
    config=read(args.config) if args.config else {'status':'descriptive_only','candidates':[]}
    if args.config and config.get('independent_verification'):
        preserved=args.config.resolve().parent/'independent_verification.json'
        if preserved.is_file() and preserved.is_relative_to(ROOT):
            config['independent_verification']={'path':preserved.relative_to(ROOT).as_posix(),'sha256':config['independent_verification']['sha256']}
    print(run(config).as_posix())
