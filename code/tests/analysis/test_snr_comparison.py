from tests.legacy import archive_path
"""Check figure line identity and shared axes without repeating PSD analysis."""
import copy
import json
from pathlib import Path
import unittest
import matplotlib.pyplot as plt

from analysis.mkgraphs.plot_snr_comparison import comparison_figure, comparison_limits

ROOT = Path(__file__).resolve().parents[3]


class SNRComparisonTests(unittest.TestCase):
    def test_exact_saved_curves_four_snrs_and_common_axes(self):
        data = json.loads((archive_path('experiment/outputs/mixture_summary/results.json')).read_text(encoding='utf-8'))
        original = copy.deepcopy(data)
        limits = comparison_limits(data)
        self.assertEqual(limits, (-80, -20))
        styles = []
        for noise in ['single', 'complex', 'changing']:
            figure, axis = comparison_figure(data, noise, limits)
            self.assertEqual(len(axis.lines), 4)
            self.assertEqual(axis.get_xlim(), (0, 8000)); self.assertEqual(axis.get_ylim(), limits)
            for line, snr in zip(axis.lines, [0, 5, 10, 20]):
                group = next(g for g in data['groups'] if g['noise'] == noise and g['snr'] == snr)
                self.assertEqual(line.get_xdata().tolist(), data['frequency_hz'])
                self.assertEqual(line.get_ydata().tolist(), group['signals']['mixture']['mean_db'])
                self.assertEqual(line.get_label(), f'SNR {snr} dB')
            styles.append([(line.get_color(), line.get_linestyle()) for line in axis.lines])
            plt.close(figure)
        self.assertEqual(styles[0], styles[1]); self.assertEqual(styles[0], styles[2])
        self.assertEqual(data, original)


if __name__ == '__main__':
    unittest.main()
