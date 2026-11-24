"""Plot completed C cohort measurements without estimating spectra or statistics."""
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from .plot_analysis import annotate_peaks


def render_summary(raw, directory, name):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    frequency = [i * raw['sample_rate_hz'] / raw['nperseg'] for i in range(1025)]
    signals = raw['signals']
    mixture = signals['mixture']
    unit = 'Normalized PSD (dB/Hz; clean interval RMS = 1)'
    paths = {}

    def save(figure, key):
        target = directory / f'{name}_{key}.png'
        figure.savefig(target, dpi=120, facecolor='white')
        plt.close(figure)
        paths[key] = target

    for view in ('welch', 'peaks'):
        figure, axis = plt.subplots(figsize=(11, 4.8), dpi=120, layout='constrained')
        for key, label, color in [('mixture', 'Mixture mean', '#236d58'), ('speech', 'Clean reference mean', '#2563eb'), ('added_noise', 'Actual added noise mean', '#c06a21')]:
            if view == 'welch' or key == 'mixture':
                axis.plot(frequency, signals[key]['mean_db'], label=label, color=color, linewidth=1)
        if view == 'welch':
            axis.fill_between(frequency, mixture['min_db'], mixture['max_db'], color='#236d58', alpha=.12, label='Mixture min-max across 12 recordings')
        else:
            for peak in mixture['peaks']:
                axis.scatter(peak['frequency_hz'], peak['magnitude_db'], s=20, color='#b85d1c')
            for anchor in mixture['noise_comparison']:
                axis.axvline(anchor['frequency_hz'], color='#888888', linestyle=':', linewidth=.7)
        axis.set(xlim=(0, 8000), xlabel='Frequency (Hz)', ylabel=unit, title=f'{name} / 12-recording mean')
        axis.grid(alpha=.2)
        axis.legend(loc='upper right', fontsize=8)
        if view == 'peaks':
            annotate_peaks(axis, mixture['peaks'])
        save(figure, view)

    times = raw['times_sec']
    temporal = mixture['temporal_peaks']
    figure, axes = plt.subplots(4, 1, figsize=(11, 12), sharex=True, layout='constrained', gridspec_kw={'height_ratios': [3, 2, 2, 1]})
    image = axes[0].pcolormesh(times, frequency, list(zip(*mixture['spectrogram_db'])), shading='nearest', cmap='magma', rasterized=True)
    figure.colorbar(image, ax=axes[0], label='Normalized PSD (dB/Hz)')
    axes[0].set(ylabel='Frequency (Hz)', title=f'{name} / mean STFT (available recordings only)')
    if temporal:
        image = axes[1].pcolormesh(times, list(range(len(temporal))), [[frame[1] for frame in row['frames']] for row in temporal], shading='nearest', vmin=0, vmax=100, cmap='YlGnBu')
        figure.colorbar(image, ax=axes[1], label='Recordings detected (%)')
        axes[1].set_yticks(range(len(temporal)), [f"{row['peak_id']}: {row['frequency_hz']:.1f} Hz" for row in temporal])
        for row in temporal:
            axes[2].vlines([t for t, frame in zip(times, row['frames']) if frame[0]],
                           [frame[2] for frame in row['frames'] if frame[0]], [frame[3] for frame in row['frames'] if frame[0]], linewidth=2, alpha=.7)
            axes[2].axhline(row['frequency_hz'], color='#999999', linestyle=':', linewidth=.6)
    axes[1].set(title='Per-time detection near original Noise peaks; not trajectory averages')
    axes[2].set(ylabel='Frequency (Hz)', title='Detected frequency ranges at each time (unconnected)')
    axes[3].step(times, raw['participant_counts'], where='mid', color='#236d58')
    axes[3].set(ylim=(0, 13), ylabel='Recordings', xlabel='Time from recording start (s)', yticks=[0, 3, 6, 9, 12])
    for axis in axes:
        axis.grid(alpha=.15)
        if raw['split_sec']:
            axis.axvline(raw['split_sec'], color='#46a6bc', linestyle='--', linewidth=1)
    save(figure, 'temporal')

    if raw['split_sec']:
        figure, axes = plt.subplots(2, 1, figsize=(11, 7), sharex=True, layout='constrained')
        for axis, key in zip(axes, ('mixture', 'added_noise')):
            axis.plot(frequency, signals[key]['before_db'], label='Before 2.5 s', color='#2563eb')
            axis.plot(frequency, signals[key]['after_db'], label='After 2.5 s', color='#c06a21')
            axis.set(ylabel='Normalized PSD (dB/Hz)', title=key, xlim=(0, 8000))
            axis.legend(); axis.grid(alpha=.2)
        axes[-1].set_xlabel('Frequency (Hz)')
        save(figure, 'change')
    return paths
