"""Compatibility entry point for the offline C analysis runner (no Python DSP)."""
import argparse

from .run_analysis import ROOT, generate


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=str, default=str(ROOT))
    generate(parser.parse_args().root)
