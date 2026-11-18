"""Measured Welch peak/overlap exploration for the registered 12-recording batch.

Does not set a filter or fabricate perceptual/metric results. Existing C FFT is retained.
"""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import wave
import numpy as np
from scipy.signal import welch, find_peaks, peak_widths

ROOT = Path(__file__).resolve().parents[3]
FS, NFFT = 16000, 2048
NOISES = ('single', 'complex', 'changing')
SNRS = (20, 10, 5, 0)


def read(path):
    with wave.open(str(path)) as wav:
        if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (FS, 1, 2):
            raise ValueError(f'{path.name}: expected 16kHz mono PCM16')
        return np.frombuffer(wav.readframes(wav.getnframes()), '<i2').astype(float) / 32768


def spectrum(x):
    return welch(x, FS, window='hann', nperseg=NFFT, noverlap=NFFT//2,
                 detrend='constant', scaling='density')[1]


def db(p):
    return 10 * np.log10(np.maximum(p, 1e-16))


def peaks(p):
    ids, properties = find_peaks(db(p), prominence=6, distance=6)
    return ids, dict(zip(ids, properties['prominences']))


def generate(root=ROOT):
    root = Path(root).resolve()
    outputs = root/'experiment/outputs'
    collection = json.loads((root/'experiment/config/collection.json').read_text(encoding='utf-8-sig'))
    metadata = list(csv.DictReader((outputs/'mixture_preparation/tables/mixtures.csv').open(encoding='utf-8-sig')))
    if len(metadata) != 144:
        raise ValueError('Expected the registered 144 mixture records')
    metadata = {r['file']: r for r in metadata}
    files = {}

    def input_file(relative, public):
        path = root/relative
        content = path.read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        files[public] = {'path': public, 'source': relative, 'sha256': digest, 'size': len(content)}
        return path, digest

    for row in collection['recordings']:
        input_file(f"{collection['source_root']}/{row['id']}.wav", f"data/clean/{row['id']}.wav")
    references = {}
    for row in collection['recordings']:
        name = row['id']
        path, _ = input_file(f'experiment/data/reference/{name}.wav', f'data/reference/{name}.wav')
        references[name] = read(path)
    f = np.fft.rfftfreq(NFFT, 1/FS)
    sources, conditions = [], []
    for noise in NOISES:
        path, _ = input_file(f'experiment/data/noise/{noise}.wav', f'data/noise/{noise}.wav')
        original = read(path)
        p = spectrum(original)
        ids, prominences = peaks(p)
        selected = ids[np.argsort(p[ids])[::-1]][:8]
        before, after = spectrum(original[:40000]), spectrum(original[40000:])
        band_energy = [{'low_hz': low, 'high_hz': high, 'energy_percent': float(p[(f >= low) & ((f < high) if high < 8000 else (f <= high))].sum() / p.sum() * 100)} for low, high in [(0,100),(100,300),(300,1000),(1000,2000),(2000,4000),(4000,8000)]]
        noise_peaks = []
        for rank, i in enumerate(selected, 1):
            widths, _, left, right = peak_widths(p, [i], rel_height=.5)
            low, high = float(left[0]*FS/NFFT), float(right[0]*FS/NFFT)
            band = (f >= low) & (f <= high)
            noise_peaks.append({'id': f'p{rank}', 'frequency_hz': float(f[i]), 'magnitude_db': float(db(p[i])),
                'prominence_db': float(prominences[i]), 'bandwidth_hz': float(widths[0]*FS/NFFT),
                'low_hz': low, 'high_hz': high,
                'time_change_db': float(db(after[band].sum())-db(before[band].sum()))})
        sources.append({'noise': noise, 'psd_db': np.round(db(p), 3).tolist(), 'before_psd_db': np.round(db(before), 3).tolist(), 'after_psd_db': np.round(db(after), 3).tolist(), 'band_energy': band_energy, 'peaks': noise_peaks})
        for snr in SNRS:
            for row in collection['recordings']:
                name = row['id']
                rel = f'mixtures/{noise}/snr{snr:02d}/{name}.wav'
                record = metadata[rel]
                path, digest = input_file('experiment/'+rel, f'data/mixed/{noise}/snr{snr:02d}/{name}.wav')
                if digest != record['sha256']:
                    raise ValueError('Registered mixture changed: '+rel)
                mixture, speech = read(path), references[name]
                if len(mixture) != len(speech):
                    raise ValueError('Reference length mismatch: '+rel)
                # Recover precisely the quantized added noise, at the mixture's actual level.
                added = mixture - speech
                a, b = round(float(record['snr_interval_start_sec'])*FS), round(float(record['snr_interval_end_sec'])*FS)
                actual_snr = float(db(np.mean(speech[a:b]**2))-db(np.mean(added[a:b]**2)))
                if abs(actual_snr-snr) > .015:
                    raise ValueError('Reference/SNR mismatch: '+rel)
                ps, pn, pm = spectrum(speech), spectrum(added), spectrum(mixture)
                mixture_ids, _ = peaks(pm)
                speech_ids, _ = peaks(ps)
                observations = []
                for peak in noise_peaks:
                    band = (f >= peak['low_hz']) & (f <= peak['high_hz'])
                    tolerance = max(2*FS/NFFT, peak['bandwidth_hz']/2)
                    nearby = [i for i in mixture_ids if abs(f[i]-peak['frequency_hz']) <= tolerance]
                    match = min(nearby, key=lambda i: abs(f[i]-peak['frequency_hz'])) if nearby else None
                    speech_peak = any(abs(f[i]-peak['frequency_hz']) <= tolerance for i in speech_ids)
                    observations.append({'peak_id': peak['id'], 'mixture_frequency_hz': float(f[match]) if match is not None else None,
                        'speech_peak_present': bool(speech_peak),
                        'speech_to_noise_db': float(db(ps[band].sum())-db(pn[band].sum()))})
                conditions.append({'noise': noise, 'snr': snr, 'statement': name, 'actual_snr_db': actual_snr,
                    'interval_sec': [a/FS, b/FS], 'speech_db': np.round(db(ps), 3).tolist(),
                    'noise_db': np.round(db(pn), 3).tolist(), 'mixture_db': np.round(db(pm), 3).tolist(),
                    'observations': observations})
    result = {'version': 1, 'status': 'exploratory', 'frequency_hz': f.tolist(),
        'recordings': collection['recordings'], 'sources': sources, 'conditions': conditions,
        'files': list(files.values()),
        'method': {'name': 'Welch PSD', 'sample_rate_hz': FS, 'nperseg': NFFT, 'noverlap': NFFT//2,
            'window': 'hann', 'detrend': 'constant', 'unit': 'dBFS/Hz', 'prominence_db': 6,
            'minimum_distance_bins': 6, 'max_source_peaks': 8, 'width': 'linear PSD half-prominence',
            'matching_tolerance': 'max(2 bins, source peak width / 2)',
            'speech_overlap': 'same-rule local speech peak and band power ratio; no peak does not mean absent speech',
            'comparison_interval': 'whole WAV for Welch; recorded speech interval for SNR',
            'candidate_status': 'measured peak-width bands for review only; no filter type/cutoff/Q selected'}}
    folder = outputs/'peak_analysis'
    folder.mkdir(exist_ok=True)
    # Retain prior measured results when inputs or methods change.
    payload = json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(',', ':'))+'\n'
    target = folder/'results.json'
    digest = hashlib.sha256(payload.encode()).hexdigest()
    if target.exists() and target.read_text() != payload:
        archive = folder/('results-'+hashlib.sha256(target.read_bytes()).hexdigest()[:12]+'.json')
        if not archive.exists(): archive.write_bytes(target.read_bytes())
    target.write_text(payload, encoding='utf-8')
    print(f'Generated {len(sources)} source peak tables, {len(conditions)} comparisons, {len(files)} verified inputs; {digest[:12]}')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    generate(parser.parse_args().root)
