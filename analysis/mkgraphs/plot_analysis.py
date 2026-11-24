"""Draw completed C output. This module never estimates spectra or detects peaks."""
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.collections import LineCollection
from matplotlib.transforms import Bbox


def annotate_peaks(axis, peaks):
    """Pack measured label boxes inside the axes, away from labels and markers."""
    if not peaks:
        return []
    figure = axis.figure
    figure.canvas.draw()  # Finalize constrained layout before measuring in pixels.
    renderer = figure.canvas.get_renderer()
    bounds = axis.get_window_extent(renderer).padded(-6)
    points = [axis.transData.transform((peak["frequency_hz"], peak["magnitude_db"])) for peak in peaks]
    occupied = [Bbox.from_bounds(x - 5, y - 5, 10, 10) for x, y in points]
    if axis.get_legend() is not None:
        occupied.append(axis.get_legend().get_window_extent(renderer).padded(4))
    annotations = []
    for peak, (x, y) in sorted(zip(peaks, points), key=lambda item: item[1][0]):
        annotation = axis.annotate(
            f'{peak["id"]}: {peak["frequency_hz"]:.1f} Hz',
            (peak["frequency_hz"], peak["magnitude_db"]), xytext=(0, 0),
            textcoords="offset pixels", fontsize=8, ha="left", va="bottom",
            bbox={"boxstyle": "round,pad=0.2", "facecolor": "white", "edgecolor": "none", "alpha": .95},
            arrowprops={"arrowstyle": "-", "color": "#8a694d", "linewidth": .7, "shrinkA": 3, "shrinkB": 4},
            zorder=5)
        annotation.set_in_layout(False)
        annotation.update_positions(renderer)
        annotation.update_bbox_position_size(renderer)
        original = annotation.get_bbox_patch().get_window_extent(renderer)
        width, height = original.width, original.height
        candidates = []
        step = height + 7
        for row in range(int(bounds.height / step) + 1):
            for bottom in (y + 12 + row * step, y - 12 - height - row * step):
                bottom = max(bounds.y0, min(bottom, bounds.y1 - height))
                for left in (x + 9, x - width / 2, x - width - 9):
                    left = max(bounds.x0, min(left, bounds.x1 - width))
                    box = Bbox.from_bounds(left, bottom, width, height)
                    if any(box.padded(3).overlaps(other) for other in occupied):
                        continue
                    distance = max(left - x, x - box.x1, 0) ** 2 + max(bottom - y, y - box.y1, 0) ** 2
                    candidates.append((bottom < y, distance, left, bottom, box))
        if not candidates:
            raise ValueError("Peak labels do not fit inside the plot; increase the figure size.")
        _, _, left, bottom, box = min(candidates, key=lambda item: item[:2])
        annotation.set_position((left - original.x0, bottom - original.y0))
        occupied.append(box.padded(3))
        annotations.append(annotation)
    return annotations


def render_analysis(raw, folder, name, title):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    frequency = [i * raw["sample_rate_hz"] / raw["nperseg"] for i in range(raw["nperseg"] // 2 + 1)]
    signal = raw["signal"]
    paths = {}

    def save(figure, key):
        destination = folder / f"{name}_{key}.png"
        figure.savefig(destination, dpi=120, facecolor="white")
        plt.close(figure)
        paths[key] = destination

    for key in ("welch", "peaks"):
        figure, axis = plt.subplots(figsize=(11, 4.5), dpi=120, layout="constrained")
        axis.plot(frequency, signal["psd_db"], color="#236d58", linewidth=1.2, label="Mixture" if "speech" in raw else "Noise")
        if "speech" in raw and key == "welch":
            axis.plot(frequency, raw["speech"]["psd_db"], color="#2563eb", linewidth=.9, alpha=.85, label="Reference speech")
            axis.plot(frequency, raw["added_noise"]["psd_db"], color="#c06a21", linewidth=.9, linestyle="--", alpha=.85, label="Actual added noise")
        if key == "peaks":
            for peak in signal["peaks"]:
                axis.scatter([peak["frequency_hz"]], [peak["magnitude_db"]], s=20, color="#b85d1c", zorder=4)
        axis.set(xlim=(0, 8000), ylim=(-120, 0), xlabel="Frequency (Hz)", ylabel="PSD (dBFS/Hz)", title=title)
        axis.grid(alpha=.2); axis.legend(loc="upper right", fontsize=9)
        if key == "peaks":
            annotate_peaks(axis, signal["peaks"])
        save(figure, key)

    figure, axes = plt.subplots(2, 1, figsize=(11, 7), sharex=True, layout="constrained")
    times = signal["times_sec"]
    image = axes[0].pcolormesh(times, frequency, list(map(list, zip(*signal["spectrogram_db"]))),
                               shading="nearest", vmin=-120, vmax=-20, cmap="magma", rasterized=True)
    figure.colorbar(image, ax=axes[0], label="PSD (dBFS/Hz)")
    axes[0].set(ylabel="Frequency (Hz)", ylim=(0, 8000), title=title + " / STFT")
    segments = [[(times[point[0]], point[1]) for point in track["points"]] for track in signal["tracking"]["tracks"]]
    axes[1].add_collection(LineCollection(segments, linewidths=.65, colors="#276c58", alpha=.65))
    points = [point for segment in segments for point in segment]
    if points:
        axes[1].scatter([point[0] for point in points], [point[1] for point in points], s=.6, color="#276c58", alpha=.4)
    axes[1].set(xlabel="Time (s)", ylabel="Peak frequency (Hz)", ylim=(0, 8000),
                xlim=(0, raw["sample_count"] / raw["sample_rate_hz"]), title="Adjacent-frame peak trajectories (all detected peaks)")
    axes[1].grid(alpha=.2)
    if "interval_sec" in raw:
        for axis in axes:
            axis.axvspan(*raw["interval_sec"], color="#80ccab", alpha=.12)
    if "changing" in name:
        for axis in axes:
            axis.axvline(2.5, color="#53cbd0", linestyle="--", linewidth=1)
    save(figure, "temporal")

    if "speech" not in raw:
        for peak in signal["peaks"]:
            figure, axis = plt.subplots(figsize=(9, 3.8), layout="constrained")
            axis.plot(frequency, signal["psd_db"], color="#236d58")
            axis.axvspan(peak["low_hz"], peak["high_hz"], alpha=.15, color="#c06a21", label="Measured half-prominence width")
            axis.set(xlim=(max(0, peak["low_hz"] - 100), min(8000, peak["high_hz"] + 100)),
                     xlabel="Frequency (Hz)", ylabel="PSD (dBFS/Hz)", title=f'{title} / {peak["id"]}')
            axis.grid(alpha=.2); axis.legend(fontsize=8)
            save(figure, "zoom_" + peak["id"])
    return paths
