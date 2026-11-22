import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import wave
import numpy as np
from scipy.signal import butter, sosfreqz, sosfilt
from experiment.src.preprocessing import design_bpf as designer
from experiment.src.preprocessing.run_prefilter import filter_file

ROOT = designer.ROOT


class ButterworthTests(unittest.TestCase):
    def test_complex_response_matches_independent_scipy_and_half_power_edges(self):
        settings, path, record, design = designer.selected_design()
        sos = np.array([[*s['b'], *s['a']] for s in design['sections']])
        reference = butter(2, [75,4000], btype='bandpass', fs=16000, output='sos')
        frequency = np.r_[np.linspace(0,8000,16001),75,4000,design['peak_frequency_hz']]
        _, actual = sosfreqz(sos, worN=frequency, fs=16000)
        _, expected = sosfreqz(reference, worN=frequency, fs=16000)
        np.testing.assert_allclose(actual, expected, atol=1e-10, rtol=0)
        np.testing.assert_allclose(abs(actual[-3:])**2,[.5,.5,1],atol=1e-10,rtol=0)
        self.assertEqual(design['digital_order'],4)
        self.assertTrue(all(s['pole_radius']<1 for s in design['sections']))

    def test_c_filter_matches_scipy_for_transients_and_multiple_frequencies(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.cache/noise_analysis') as folder:
            folder=Path(folder); executable=folder/'filter.exe'
            subprocess.run([str(ROOT/'.tools/tcc/tcc.exe'),'-std=c99','-Wall','-Werror',str(ROOT/'experiment/src/preprocessing/prefilter.c'),'-o',str(executable)],check=True)
            sections=designer.selected_design()[3]['sections']
            time=np.arange(32000)/16000
            samples=np.rint(sum(1500*np.sin(2*np.pi*f*time) for f in [25,75,150,1000,4000,6000])).astype('<i2')
            samples[0]+=8000
            source=folder/'input.wav'; target=folder/'output.wav'
            with wave.open(str(source),'wb') as stream:
                stream.setparams((1,2,16000,0,'NONE','not compressed')); stream.writeframes(samples.tobytes())
            original=source.read_bytes(); filter_file(executable,source,target,sections)
            reference=sosfilt(butter(2,[75,4000],btype='bandpass',fs=16000,output='sos'),samples.astype(float)/32768)*32768
            reference=np.where(reference>=0,np.floor(reference+.5),np.ceil(reference-.5))
            with wave.open(str(target),'rb') as stream: actual=np.frombuffer(stream.readframes(stream.getnframes()),'<i2')
            np.testing.assert_allclose(actual,reference,atol=1,rtol=0)
            self.assertEqual(source.read_bytes(),original)
            with self.assertRaises(subprocess.CalledProcessError): filter_file(executable,source,target,sections)

    def test_selected_config_rejects_silent_order_cutoff_and_scope_changes(self):
        settings=designer.read_json(designer.CONFIG)
        for field,value in [('lower_hz',100),('upper_hz',3500),('digital_order',8),('prototype_order',4),('planned_count',36),('processing','filtfilt')]:
            changed=json.loads(json.dumps(settings)); changed[field]=value
            with self.assertRaises(ValueError): designer.validate_settings(changed)

    def test_completed_144_wavs_match_independent_scipy(self):
        pointer=ROOT/'experiment/outputs/bpf_results.json'
        if not pointer.exists(): self.skipTest('Selected BPF batch has not yet run.')
        data=designer.read_json(ROOT/designer.read_json(pointer)['manifest'])
        self.assertEqual(data['actual_count'],144)
        sos=butter(2,[75,4000],btype='bandpass',fs=16000,output='sos')
        for row in data['conditions']:
            source=ROOT/'experiment/mixtures'/row['input_path'].removeprefix('data/mixed/')
            target=ROOT/'experiment/outputs/enhanced'/row['output_path'].removeprefix('outputs/')
            self.assertEqual(designer.digest(source),row['input_sha256']); self.assertEqual(designer.digest(target),row['output_sha256'])
            with wave.open(str(source),'rb') as stream: samples=np.frombuffer(stream.readframes(stream.getnframes()),'<i2')
            with wave.open(str(target),'rb') as stream:
                self.assertEqual((stream.getframerate(),stream.getnchannels(),stream.getsampwidth(),stream.getnframes()),(16000,1,2,len(samples)))
                actual=np.frombuffer(stream.readframes(stream.getnframes()),'<i2')
            gain=10**(data['settings']['comparison_gain_db']/20)
            reference=sosfilt(sos,samples.astype(float)/32768)*32768*gain
            reference=np.where(reference>=0,np.floor(reference+.5),np.ceil(reference-.5))
            np.testing.assert_allclose(actual,reference,atol=1,rtol=0)
            self.assertEqual(row['clipped_samples'],0)
            comparison=ROOT/'experiment/outputs/enhanced'/row['comparison_input_path'].removeprefix('outputs/')
            if not comparison.exists(): continue  # Optional local archive, absent in an active-data-only clone.
            self.assertEqual(designer.digest(comparison),row['comparison_input_sha256'])
            expected=samples.astype(float)*gain
            expected=np.where(expected>=0,np.floor(expected+.5),np.ceil(expected-.5))
            with wave.open(str(comparison),'rb') as stream:
                dry=np.frombuffer(stream.readframes(stream.getnframes()),'<i2')
            np.testing.assert_array_equal(dry,expected)


if __name__=='__main__': unittest.main()
