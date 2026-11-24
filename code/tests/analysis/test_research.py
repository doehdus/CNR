"""Independent numerical and boundary checks for the new research protocol."""
import hashlib
import csv
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import wave

import numpy as np
from scipy.signal import spectrogram, welch

from analysis.mkgraphs.run_research import ROOT, PROFILES, aggregate
from analysis.mkgraphs.graph_output import write_graph_outputs


class ResearchAnalysisTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(dir=ROOT / '.cache/noise_analysis')
        cls.base = Path(cls.temporary.name)
        cls.executables = {}
        for name, (n, hop) in PROFILES.items():
            exe = cls.base / (name + '.exe')
            subprocess.run([str(ROOT / '.tools/tcc/tcc.exe'), '-std=c99', '-Wall', '-Werror',
                f'-DFFT_SIZE={n}', f'-DHOP={hop}', str(ROOT / 'analysis/mkgraphs/research_analysis.c'), '-o', str(exe)], check=True)
            cls.executables[name] = exe

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def setUp(self):
        self.temporary_case = tempfile.TemporaryDirectory(dir=self.base)
        self.addCleanup(self.temporary_case.cleanup)
        self.directory = Path(self.temporary_case.name)

    def wav(self, name, signal):
        path = self.directory / (name + '.wav')
        pcm = np.rint(np.asarray(signal) * 32768).astype('<i2')
        with wave.open(str(path), 'wb') as stream:
            stream.setparams((1, 2, 16000, 0, 'NONE', 'not compressed')); stream.writeframes(pcm.tobytes())
        return path, pcm.astype(float) / 32768

    def run_job(self, profile, source, **options):
        output = self.directory / f'{profile}-{len(list(self.directory.glob("*.json")))}.json'
        command = [str(self.executables[profile]), '--input', str(source), '--output', str(output)]
        for key, value in options.items():
            command.extend(['--' + key.replace('_', '-'), str(value)])
        subprocess.run(command, check=True)
        return json.loads(output.read_text()), command, output

    def test_both_resolutions_and_registered_frame_policy_match_independent_scipy(self):
        rng = np.random.default_rng(1123)
        time = np.arange(48000) / 16000
        source, x = self.wav('source', .12 * np.sin(2 * np.pi * 183 * time) + .04 * rng.normal(size=len(time)))
        start, end = 5431, 38119
        for profile, (n, hop) in PROFILES.items():
            with self.subTest(profile=profile):
                data, _, _ = self.run_job(profile, source, start=start, end=end, spectrogram=1)
                f, times, psd = spectrogram(x, 16000, window='hann', nperseg=n, noverlap=n-hop, detrend='constant', scaling='density', mode='psd')
                starts = np.arange(psd.shape[1]) * hop
                selected = (starts >= start) & (starts + n <= end)
                np.testing.assert_allclose(data['signal']['whole']['psd'], psd.mean(axis=1), rtol=1e-9, atol=1e-17)
                np.testing.assert_allclose(data['signal']['primary']['psd'], psd[:, selected].mean(axis=1), rtol=1e-9, atol=1e-17)
                np.testing.assert_allclose(data['signal']['times_sec'], times, rtol=0, atol=1e-14)
                np.testing.assert_allclose(data['signal']['spectrogram_db'], (10*np.log10(psd)).T, rtol=0, atol=1e-7)
                self.assertEqual(data['signal']['primary']['frame_count'], int(selected.sum()))
                rms = np.sqrt(np.mean(x[start:end] ** 2))
                self.assertAlmostEqual(data['reference_rms'], rms, places=14)
                np.testing.assert_allclose(data['signal']['normalized_primary']['psd'], psd[:, selected].mean(axis=1)/rms**2, rtol=1e-9, atol=1e-15)
                self.assertAlmostEqual(data['signal']['primary']['cumulative_percent'][-1], 100, places=10)

    def test_mixture_only_prefix_errors_and_time_snr_match_direct_reference_calculations(self):
        rng = np.random.default_rng(24); time = np.arange(48000)/16000
        speech = .1*np.sin(2*np.pi*370*time); speech[:9000] = 0
        clean_path, clean = self.wav('clean', speech)
        mixed_path, mixed = self.wav('mixed', speech+.03*rng.normal(size=len(time)))
        before = {p:hashlib.sha256(p.read_bytes()).hexdigest() for p in (clean_path,mixed_path)}
        start,end,limit = 10001,38119,8000
        data, command, output = self.run_job('temporal',mixed_path,reference=clean_path,start=start,end=end,initial_limit=limit)
        actual_noise = mixed-clean
        self.assertAlmostEqual(data['actual_snr_db'],10*np.log10(np.sum(clean[start:end]**2)/np.sum(actual_noise[start:end]**2)),places=11)
        _,_,noise_psd=spectrogram(actual_noise,16000,window='hann',nperseg=512,noverlap=256,detrend='constant',scaling='density')
        _,_,mixed_psd=spectrogram(mixed,16000,window='hann',nperseg=512,noverlap=256,detrend='constant',scaling='density')
        starts=np.arange(noise_psd.shape[1])*256;selected=(starts>=start)&(starts+512<=end)
        true=noise_psd[:,selected].mean(axis=1)
        for i,row in enumerate(data['initial_estimates']):
            estimate=mixed_psd[:,:i+1].mean(axis=1)
            self.assertLessEqual(row['end_sample'],limit)
            self.assertAlmostEqual(row['power_bias_db'],10*np.log10(estimate.sum()/true.sum()),places=10)
            self.assertAlmostEqual(row['shape_tvd'],.5*np.abs(estimate/estimate.sum()-true/true.sum()).sum(),places=10)
            self.assertEqual(row['speech_component_percent'],0)
        short_snr=[]
        for begin in starts[selected]:
            short_snr.append(10*np.log10(np.sum(clean[begin:begin+512]**2)/np.sum(actual_noise[begin:begin+512]**2)))
        self.assertAlmostEqual(data['frame_snr_summary']['median_db'],np.median(short_snr),places=10)
        saved=output.read_bytes()
        self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)
        self.assertEqual(output.read_bytes(),saved)
        self.assertEqual(before,{p:hashlib.sha256(p.read_bytes()).hexdigest() for p in before})

    def test_changing_split_is_explicit_and_excludes_crossing_frames(self):
        time=np.arange(96000)/16000
        source,x=self.wav('changing',.1*np.sin(2*np.pi*500*time)+np.where(time>=2.5,.1*np.sin(2*np.pi*1200*time),0))
        ordinary,_,_=self.run_job('temporal',source)
        self.assertNotIn('before',ordinary['signal'])
        split,_,_=self.run_job('temporal',source,split=40000)
        _,_,psd=spectrogram(x,16000,window='hann',nperseg=512,noverlap=256,detrend='constant',scaling='density')
        starts=np.arange(psd.shape[1])*256
        for key,mask in [('before',starts+512<=40000),('after',starts>=40000)]:
            np.testing.assert_allclose(split['signal'][key]['psd'],psd[:,mask].mean(axis=1),rtol=1e-8,atol=1e-17)
            self.assertEqual(split['signal'][key]['frame_count'],int(mask.sum()))

    def test_group_mean_is_equal_recording_linear_power_and_uses_same_component_gain(self):
        def component(value):return {'primary':{'psd':[value]*257},'whole':{'psd':[value*2]*257}}
        members=[]
        for gain,value in [(1.,1.),(2.,9.)]:
            speech={'normalization_gain':gain,'signal':component(value)}
            mixture={'signal':component(value*3),'added_noise':component(value*2),
                     'frame_snr_summary':{'valid':3,'median_db':value},'initial_estimates':[]}
            members.append((speech,mixture))
        group=aggregate(self.executables['temporal'],self.directory,'group-result.json',members,'temporal')
        expected=(1+9*4)/2
        np.testing.assert_allclose(group['signals']['speech']['primary']['psd'],expected)
        np.testing.assert_allclose(group['signals']['mixture']['primary']['psd'],expected*3)
        np.testing.assert_allclose(group['signals']['mixture']['primary']['psd_db'],10*np.log10(expected*3))
        np.testing.assert_allclose(group['speech_noise_ratio_db'],10*np.log10(.5))
        self.assertEqual(group['frame_snr_summary'],{'count':2,'mean':5,'min':1,'max':9})

    def test_silence_is_explicitly_missing_in_db_without_inventing_power_or_snr(self):
        source,_=self.wav('silence',np.zeros(8192))
        result,_,_=self.run_job('temporal',source,reference=source,start=1024,end=7168,initial_limit=1024)
        self.assertEqual(result['signal']['primary']['total_power'],0)
        self.assertTrue(all(value is None for value in result['signal']['primary']['psd_db']))
        self.assertIsNone(result['normalization_gain']);self.assertIsNone(result['actual_snr_db'])
        self.assertEqual(result['frame_snr_summary']['valid'],0)
        self.assertTrue(all(row['shape_tvd'] is None for row in result['initial_estimates']))

    def test_graph_output_uses_existing_hierarchy_is_idempotent_and_refuses_overwrite(self):
        root=self.directory/'workspace';run_id='20261123T000000Z-12345678'
        run=root/'analysis/results/signals'/run_id;(run/'graphs').mkdir(parents=True)
        graphs=[];artifacts={}
        categories = [
            ('clean','waveform',12,'01_음성_파형_RMS_스펙트로그램'),
            ('clean','spectrum',2,'02_화자별_음성_PSD_누적전력'),
            ('noise','source',3,'03_소음_PSD_누적전력_스펙트로그램'),
            ('noise','change',1,'04_변화소음_전후_PSD_비교'),
            ('mixture','mean_psd',1,'05_합성음_SNR별_평균_PSD'),
            ('mixture','overlap',1,'06_음성대소음_주파수별_전력비'),
            ('mixture','time_snr',1,'07_합성음_단시간_SNR_중앙값_비교'),
            ('estimation','initial_noise',3,'08_초기_소음추정_오차'),
        ]
        expected_folders={}
        for kind,role,count,folder in categories:
            for i in range(count):
                identity=f'{kind}_{role}_{i}';relative='graphs/'+identity+'.png';path=run/relative
                path.write_bytes(b'\x89PNG\r\n\x1a\n'+identity.encode())
                record={'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'size':path.stat().st_size}
                graphs.append({'id':identity,'kind':kind,'role':role,'path':relative,**record});artifacts[relative]=record
                expected_folders[identity]=folder
        result=run/'results.json';result.write_text(json.dumps({'run_id':run_id,'graphs':graphs}),encoding='utf-8')
        artifacts['results.json']={'sha256':hashlib.sha256(result.read_bytes()).hexdigest(),'size':result.stat().st_size}
        manifest=run/'manifest.json';manifest.write_text(json.dumps({'artifacts':artifacts}),encoding='utf-8')
        pointer={'run_id':run_id,'manifest':manifest.relative_to(root).as_posix(),'sha256':hashlib.sha256(manifest.read_bytes()).hexdigest()}
        (run.parent/'latest.json').write_text(json.dumps(pointer),encoding='utf-8')
        placed=write_graph_outputs(root);self.assertEqual(placed,write_graph_outputs(root));self.assertEqual(placed['graph_count'],24)
        for row in placed['graphs']:
            self.assertEqual(row['path'],f"analysis/graphs/{expected_folders[row['id']]}/{run_id}/{row['id']}.png")
            self.assertEqual(hashlib.sha256((root/row['path']).read_bytes()).hexdigest(),row['sha256'])
        changed=root/placed['graphs'][0]['path'];changed.write_bytes(b'preserve changed local file')
        with self.assertRaisesRegex(ValueError,'overwritten'):write_graph_outputs(root)
        self.assertEqual(changed.read_bytes(),b'preserve changed local file')

    def test_completed_actual_group_curves_match_independent_wav_measurements(self):
        pointer_path=ROOT/'analysis/results/signals/latest.json'
        if not pointer_path.is_file():self.skipTest('No completed research batch.')
        pointer=json.loads(pointer_path.read_text());run=(ROOT/pointer['manifest']).parent
        results=json.loads((run/'results.json').read_text(encoding='utf-8'))
        self.assertEqual(results['actual_counts']['graphs'],24)
        self.assertEqual(len(list((run/'graphs').glob('*.png'))),24)
        with (ROOT/'data/preparation/tables/mixtures.csv').open(encoding='utf-8-sig',newline='') as stream:
            metadata=list(csv.DictReader(stream))
        def load(path):
            with wave.open(str(path),'rb') as stream:return np.frombuffer(stream.readframes(stream.getnframes()),'<i2').astype(float)/32768
        def psd(signal,start,end):
            _,_,p=spectrogram(signal,16000,window='hann',nperseg=2048,noverlap=1024,detrend='constant',scaling='density')
            begins=np.arange(p.shape[1])*1024;mask=(begins>=start)&(begins+2048<=end)
            return p[:,mask].mean(axis=1)
        refs={r['id']:load(ROOT/'data/reference'/(r['id']+'.wav')) for r in results['recordings']}
        for noise in ('single','complex','changing'):
            for snr in (20,10,5,0):
                expected={'speech':[],'added_noise':[],'mixture':[]}
                for row in metadata:
                    if row['noise']!=noise or int(row['snr_target_db'])!=snr:continue
                    identity=Path(row['file']).stem;speech=refs[identity];mixture=load(ROOT/'data'/row['file'])
                    start=round(float(row['snr_interval_start_sec'])*16000);end=round(float(row['snr_interval_end_sec'])*16000)
                    gain=1/np.sqrt(np.mean(speech[start:end]**2))
                    for key,signal in [('speech',speech),('added_noise',mixture-speech),('mixture',mixture)]:
                        expected[key].append(psd(signal,start,end)*gain**2)
                measured=json.loads((run/f'summary/{noise}_snr{snr:02d}_spectral.json').read_text())
                self.assertEqual(measured['member_count'],12)
                means={key:np.mean(values,axis=0) for key,values in expected.items()}
                for key,values in means.items():
                    np.testing.assert_allclose(measured['signals'][key]['primary']['psd'],values,rtol=1e-9,atol=1e-15)
                np.testing.assert_allclose(measured['speech_noise_ratio_db'],10*np.log10(means['speech']/means['added_noise']),atol=1e-7,rtol=0)


if __name__=='__main__':unittest.main()
