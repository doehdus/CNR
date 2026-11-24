"""Render saved C measurements. No FFT, PSD averaging, RMS or SNR estimation."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
os.environ.setdefault('MPLCONFIGDIR', str(ROOT / '.cache/matplotlib'))
import matplotlib
matplotlib.use('Agg')
from matplotlib import font_manager
import matplotlib.pyplot as plt
import numpy as np
import soundfile as sf

if Path('C:/Windows/Fonts/malgun.ttf').is_file():
    font_manager.fontManager.addfont('C:/Windows/Fonts/malgun.ttf')
    plt.rcParams['font.family'] = font_manager.FontProperties(fname='C:/Windows/Fonts/malgun.ttf').get_name()
plt.rcParams.update({'axes.spines.top': False, 'axes.spines.right': False, 'font.size': 10,
                     'axes.unicode_minus': False, 'figure.facecolor': 'white'})

NOISES = ('single', 'complex', 'changing')
SNRS = (20, 10, 5, 0)
COLORS = ('#0072B2', '#009E73', '#D55E00', '#8D5AA5')
STYLES = ('-', '--', '-.', ':')
SPECTROGRAM_RANGE = (-120, -20)  # Display clipping only; full raw measurements are preserved.


def array(values):
    return np.asarray(values, dtype=float)


def frequency(profile='spectral'):
    n = 2048 if profile == 'spectral' else 512
    return np.arange(n // 2 + 1) * 16000 / n


def spectrogram(fig, axis, data, *, label='PSD (dBFS/Hz)'):
    image = axis.pcolormesh(data['times_sec'], frequency('temporal'),
        np.ma.masked_invalid(array(data['spectrogram_db']).T), shading='nearest',
        cmap='magma', vmin=SPECTROGRAM_RANGE[0], vmax=SPECTROGRAM_RANGE[1], rasterized=True)
    axis.set(ylabel='Frequency (Hz)', ylim=(0, 8000))
    fig.colorbar(image, ax=axis, label=label, extend='both', pad=.015)


def render(root, stage, recordings, clean, noises, mixtures, groups, speaker_groups):
    graphs = []
    directory = stage / 'graphs'; directory.mkdir()
    f = frequency()
    normalized = 'Normalized PSD (dB/Hz; paired Clean RMS = 1)'

    def save(fig, identity, title, kind, role, explanation, *, note='', legend=False, **details):
        fig.suptitle(title, fontsize=15, y=.99)
        fig.tight_layout(rect=(0, .045, 1, .89 if legend else .95))
        if note:
            fig.text(.5, .008, note, ha='center', va='bottom', fontsize=8)
        relative = 'graphs/' + identity + '.png'
        fig.savefig(stage / relative, dpi=160, facecolor='white')
        plt.close(fig)
        graphs.append({'id': identity, 'path': relative, 'title': title, 'kind': kind, 'role': role,
                       'explanation': explanation, **details})

    for recording in recordings:
        identity = recording['id']
        short = clean[identity, 'temporal']
        signal = short['signal']
        fig, axes = plt.subplots(4, 1, figsize=(12, 11), sharex=True,
                                 gridspec_kw={'height_ratios': [1, 1, 1, 2.2]})
        for axis, folder, color, title in [(axes[0], 'clean', '#506d87', 'Original recording'),
                                           (axes[1], 'reference', '#236d58', 'Paired 16 kHz reference')]:
            samples, rate = sf.read(root / f'data/{folder}/{identity}.wav', dtype='float64')
            axis.plot(np.arange(len(samples)) / rate, samples, color=color, linewidth=.4)
            axis.set(ylabel='Amplitude (FS)', title=title, ylim=(-1, 1))
        axes[2].plot(signal['times_sec'], signal['rms'], color='#236d58', linewidth=1)
        axes[2].set(ylabel='RMS (FS)', title='32 ms unwindowed frame RMS')
        spectrogram(fig, axes[3], signal)
        axes[3].set(xlabel='Time from recording start (s)', title='32 ms Hann / 16 ms hop')
        begin, end = short['start_sample'] / 16000, short['end_sample'] / 16000
        for axis in axes:
            axis.axvspan(begin, end, color='#80ccab', alpha=.12); axis.grid(alpha=.12)
            axis.axvline(begin, color='#236d58', linewidth=.6, linestyle=':'); axis.axvline(end, color='#236d58', linewidth=.6, linestyle=':')
        save(fig, 'C1_' + identity, f"{identity} · {recording['speaker']}\n{recording['text']}", 'clean', 'waveform',
             '원본·대응 기준음의 레벨, 등록 발화 구간과 시간별 음성 성분을 확인합니다.',
             note='Shading: registered speech interval including pauses. Color display: -120 to -20 dBFS/Hz; raw values preserved.',
             statement=identity, speaker=recording['speaker'])

    for index, (speaker, summary) in enumerate(speaker_groups.items(), 1):
        fig, axes = plt.subplots(2, 1, figsize=(12, 8), sharex=True)
        for recording in recordings:
            if recording['speaker'] != speaker:
                continue
            signal = clean[recording['id'], 'spectral']['signal']['normalized_primary']
            axes[0].plot(f, array(signal['psd_db']), alpha=.55, linewidth=.9, label=recording['id'])
            axes[1].plot(f, array(signal['cumulative_percent']), alpha=.55, linewidth=.9)
        mean = summary['signals']['speech']
        axes[0].plot(f, array(mean['primary']['psd_db']), color='#172c30', linewidth=2, label='Primary interval mean')
        axes[0].plot(f, array(mean['whole']['psd_db']), color='#172c30', linewidth=1.2, linestyle=':', label='Whole recording mean')
        axes[1].plot(f, array(mean['primary']['cumulative_percent']), color='#172c30', linewidth=2)
        axes[0].set(ylabel=normalized); axes[1].set(ylabel='Cumulative spectral power (%)', xlabel='Frequency (Hz)', ylim=(0, 100))
        axes[0].legend(fontsize=8, ncol=2)
        for axis in axes:
            axis.set_xlim(0, 8000); axis.grid(alpha=.18)
        save(fig, f'C2_speaker{index}', f'Clean speech spectrum and cumulative power · {speaker}', 'clean', 'spectrum',
             '차단 주파수에 따른 음성 전력 손실과 같은 화자 내 문장별 차이를 확인합니다.',
             note='Six recordings, equal weight in linear PSD. Cumulative power is not intelligibility.', speaker=speaker)

    for noise in NOISES:
        long, short = noises[noise, 'spectral']['signal'], noises[noise, 'temporal']['signal']
        fig, axes = plt.subplots(3, 1, figsize=(12, 10), gridspec_kw={'height_ratios': [1, 1, 1.6]})
        axes[0].plot(f, array(long['whole']['psd_db']), color='#c06a21')
        axes[0].set(xlabel='Frequency (Hz)', ylabel='PSD (dBFS/Hz)', xlim=(0, 8000))
        axes[1].plot(f, array(long['whole']['cumulative_percent']), color='#c06a21')
        axes[1].set(xlabel='Frequency (Hz)', ylabel='Cumulative spectral power (%)', xlim=(0, 8000), ylim=(0, 100))
        spectrogram(fig, axes[2], short); axes[2].set_xlabel('Time (s)')
        if noise == 'changing':
            axes[2].axvline(2.5, color='#53cbd0', linestyle='--', linewidth=1)
        for axis in axes:
            axis.grid(alpha=.15)
        save(fig, 'N1_' + noise, noise.capitalize() + ' · original noise spectrum and time variation', 'noise', 'source',
             '소음의 전력 분포·집중 대역과 시간 변화를 확인합니다. 합성에 추가된 소음의 레벨과는 구분합니다.',
             note='Original noise level; 128 ms PSD and 32 ms spectrogram. Color display: -120 to -20 dBFS/Hz.', noise=noise)

    changing = noises['changing', 'spectral']['signal']
    fig, axes = plt.subplots(2, 1, figsize=(12, 7), sharex=True)
    axes[0].plot(f, array(changing['before']['psd_db']), label='Before 2.5 s', color='#0072B2')
    axes[0].plot(f, array(changing['after']['psd_db']), label='After 2.5 s', color='#D55E00')
    axes[0].set_ylabel('PSD (dBFS/Hz)'); axes[0].legend()
    axes[1].plot(f, array(changing['change_db']), color='#236d58'); axes[1].axhline(0, color='#888', linewidth=.7)
    axes[1].set(xlabel='Frequency (Hz)', ylabel='After / before PSD (dB)', xlim=(0, 8000))
    for axis in axes:
        axis.grid(alpha=.18)
    save(fig, 'N2_changing', 'Changing noise · before and after the registered 2.5 s transition', 'noise', 'change',
         '변화 후 증가한 주파수 성분을 확인하고 초기 고정 소음 추정의 한계를 살펴봅니다.',
         note='Complete global-grid frames inside each period; boundary-crossing frames excluded.', noise='changing')

    for role in ('mean_psd', 'overlap'):
        fig, axes = plt.subplots(1, 3, figsize=(18, 5.6), sharex=True, sharey=True)
        for axis, noise in zip(axes, NOISES):
            for snr, color, style in zip(SNRS, COLORS, STYLES):
                group = groups[noise, snr, 'spectral']
                values = group['signals']['mixture']['primary']['psd_db'] if role == 'mean_psd' else group['speech_noise_ratio_db']
                axis.plot(f, array(values), color=color, linestyle=style, linewidth=1.5, label=f'{snr} dB')
                if role == 'mean_psd':
                    axis.fill_between(f, array(group['signals']['mixture']['min_db']), array(group['signals']['mixture']['max_db']), color=color, alpha=.07)
            axis.set(title=noise.capitalize(), xlabel='Frequency (Hz)', xlim=(0, 8000), xticks=[0, 2000, 4000, 6000, 8000])
            axis.grid(alpha=.2)
            if role == 'overlap':
                axis.axhline(0, color='#777', linewidth=.8)
        axes[0].set_ylabel(normalized if role == 'mean_psd' else 'Mean Clean PSD / mean added-noise PSD (dB)')
        fig.legend(*axes[0].get_legend_handles_labels(), loc='upper center', bbox_to_anchor=(.5, .94), ncol=4, title='Input SNR', frameon=False)
        save(fig, 'M1_mean_psd' if role == 'mean_psd' else 'M2_overlap',
             'Mixture mean PSD · 12 statements per noise/SNR' if role == 'mean_psd' else 'Speech / actual added-noise spectral power ratio',
             'mixture', role,
             '소음별 SNR 4곡선으로 평균 전력 분포와 문장별 범위를 비교합니다.' if role == 'mean_psd' else '음성과 소음이 우세한 주파수와 중첩을 확인합니다. 0 dB는 같은 성분 전력입니다.',
             note='Registered intervals; equal recording weights in linear power; same paired-Clean gain for all components.' + (' Shading: recording min-max.' if role == 'mean_psd' else ' Ratio of means, not mean of dB ratios.'), legend=True)

    fig, axes = plt.subplots(1, 3, figsize=(18, 5.6), sharey=True)
    for axis, noise in zip(axes, NOISES):
        for x, (snr, color) in enumerate(zip(SNRS, COLORS)):
            group = groups[noise, snr, 'temporal']; summary = group['frame_snr_summary']
            values = array(group['frame_snr_member_medians_db'])
            axis.scatter([x + (i - 5.5) * .025 for i in range(len(values))], values, s=18, color=color, alpha=.5)
            axis.errorbar(x, summary['mean'], yerr=[[summary['mean'] - summary['min']], [summary['max'] - summary['mean']]],
                          fmt='D', color='#172c30', markersize=5, capsize=5)
        axis.set(title=noise.capitalize(), xlabel='Input SNR (dB)', xticks=range(4), xticklabels=SNRS)
        axis.grid(alpha=.18); axis.axhline(0, color='#888', linewidth=.7)
    axes[0].set_ylabel('Per-recording median short-time SNR (dB)')
    save(fig, 'M3_short_snr', 'Short-time SNR · recording-level variation', 'mixture', 'time_snr',
         '각 문장의 단시간 SNR 중앙값과 그룹 평균·범위를 비교합니다. 내부 쉼도 포함되며 단어 정답률이 아닙니다.',
         note='Dots: 12 recording medians. Diamond: equal-recording mean; whiskers: min-max. 32 ms / 16 ms; zero-power frames counted separately.')

    for noise in NOISES:
        fig, axes = plt.subplots(3, 1, figsize=(12, 10), sharex=True)
        for snr, color, style in zip(SNRS, COLORS, STYLES):
            rows = groups[noise, snr, 'temporal']['initial_estimates']
            times = [r['duration_sec'] for r in rows]
            for axis, field in zip(axes, ('power_bias_db', 'shape_tvd', 'speech_component_percent')):
                axis.plot(times, [r[field]['mean'] for r in rows], color=color, linestyle=style, label=f'{snr} dB')
                axis.fill_between(times, [r[field]['min'] for r in rows], [r[field]['max'] for r in rows], color=color, alpha=.09)
        axes[0].set_ylabel('Estimated / true noise power (dB)'); axes[0].axhline(0, color='#777', linewidth=.7)
        axes[1].set(ylabel='Unit-sum PSD shape error (TVD)', ylim=(0, 1))
        axes[2].set(ylabel='Clean / (Clean + Noise) power (%)', xlabel='Initial prefix duration (s)', ylim=(0, 100))
        for axis in axes:
            axis.grid(alpha=.18)
        axes[0].legend(title='Input SNR', ncol=4, fontsize=9)
        save(fig, 'E1_' + noise, noise.capitalize() + ' · mixture-only initial noise estimation diagnostic', 'estimation', 'initial_noise',
             '초기 구간 길이에 따른 전력 편향·형상 오차·음성 혼입을 확인합니다.',
             note='Mean of 12 recording diagnostics; shading: min-max. True target: added noise in registered interval. No estimator length selected.', noise=noise)
    return graphs
