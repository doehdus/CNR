/* Offline, one-sided Welch/STFT and peak analysis of registered PCM16 signals.
 * Numerical work lives here. The Python runner only handles manifests and files.
 * No filtering, gain normalization, padding, or sample-rate conversion is done.
 */
#include <errno.h>
#include <float.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define FS 16000
#ifndef FFT_SIZE
#define FFT_SIZE 2048
#endif
#ifndef HOP
#define HOP 1024
#endif
#define BINS (FFT_SIZE / 2 + 1)
#define MAX_PEAKS (BINS / 2)
#define TOP_PEAKS 8
#define PI 3.14159265358979323846264338327950288
#define TOOL "cnr-frequency-analysis/1"
/* Keep operand evaluation local: TinyCC's Win64 external fmax call can clobber
 * an earlier floating argument when a later argument is an expression. */
#define MAXIMUM(a, b) ((a) > (b) ? (a) : (b))

typedef struct { size_t count; double *samples; } Wave;
typedef struct {
    int bin, left_base, right_base;
    double power, prominence, low, high;
} Peak;
typedef struct { int count; Peak peaks[MAX_PEAKS]; } Peaks;
typedef struct { int id, first, last, count; double sum, square, width_sum; } Track;
typedef struct {
    size_t frames, samples;
    double psd[BINS], *frames_psd;
    Peaks average, *frame_peaks;
    Track *tracks;
    int track_count;
} Analysis;
typedef struct { int id; double frequency, width, low, high; } Anchor;
typedef struct { int previous, current; double distance; } Pair;
static double minimum_prominence = 6, minimum_match_bins = 2, match_width_fraction = .5;
static int minimum_distance_bins = 6;

static void fail(const char *message) {
    fprintf(stderr, "Frequency analysis failed: %s\n", message);
    exit(EXIT_FAILURE);
}
static void *allocate(size_t count, size_t size) {
    void *value;
    if (!count || size > SIZE_MAX / count) fail("allocation size overflow");
    value = calloc(count, size);
    if (!value) fail("cannot allocate analysis buffers");
    return value;
}
static uint16_t u16(const unsigned char *p) { return (uint16_t)(p[0] | ((uint16_t)p[1] << 8)); }
static uint32_t u32(const unsigned char *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static void exact(FILE *file, unsigned char *bytes, size_t count) {
    if (fread(bytes, 1, count, file) != count) fail("truncated WAV");
}
static Wave read_wave(const char *path) {
    FILE *file = fopen(path, "rb");
    unsigned char header[16];
    long length, end, offset = -1;
    uint32_t bytes = 0;
    int format = 0;
    size_t i;
    Wave wave;
    if (!file) fail("cannot open WAV");
    if (fseek(file, 0, SEEK_END) || (length = ftell(file)) < 12) fail("invalid WAV length");
    rewind(file); exact(file, header, 12);
    if (memcmp(header, "RIFF", 4) || memcmp(header + 8, "WAVE", 4)) fail("expected RIFF/WAVE");
    if ((uint64_t)u32(header + 4) + 8 > (uint64_t)length || (uint64_t)u32(header + 4) + 8 > LONG_MAX)
        fail("invalid RIFF boundary");
    end = (long)((uint64_t)u32(header + 4) + 8);
    while (ftell(file) <= end - 8) {
        uint32_t size;
        uint64_t next;
        exact(file, header, 8); size = u32(header + 4);
        next = (uint64_t)ftell(file) + size + (size & 1);
        if (next > (uint64_t)end || next > LONG_MAX) fail("chunk outside RIFF boundary");
        if (!memcmp(header, "fmt ", 4)) {
            if (format || size < 16) fail("invalid format chunk");
            exact(file, header, 16);
            if (u16(header) != 1 || u16(header + 2) != 1 || u32(header + 4) != FS ||
                u32(header + 8) != FS * 2 || u16(header + 12) != 2 || u16(header + 14) != 16)
                fail("expected 16kHz mono PCM16");
            format = 1;
        } else if (!memcmp(header, "data", 4)) {
            if (offset >= 0) fail("multiple data chunks");
            offset = ftell(file); bytes = size;
        }
        if (fseek(file, (long)next, SEEK_SET)) fail("cannot seek WAV chunk");
    }
    if (!format || offset < 0 || bytes % 2 || bytes / 2 < FFT_SIZE) fail("missing or insufficient PCM data");
    wave.count = bytes / 2; wave.samples = allocate(wave.count, sizeof(double));
    if (fseek(file, offset, SEEK_SET)) fail("cannot seek samples");
    for (i = 0; i < wave.count; ++i) {
        int value;
        exact(file, header, 2); value = u16(header);
        if (value >= 32768) value -= 65536;
        wave.samples[i] = value / 32768.0;
    }
    if (fclose(file)) fail("cannot close WAV");
    return wave;
}
static void fft(double *real, double *imaginary) {
    size_t i, reversed = 0, width;
    for (i = 1; i < FFT_SIZE; ++i) {
        size_t bit = FFT_SIZE >> 1;
        while (reversed & bit) { reversed ^= bit; bit >>= 1; }
        reversed ^= bit;
        if (i < reversed) {
            double temporary = real[i]; real[i] = real[reversed]; real[reversed] = temporary;
            temporary = imaginary[i]; imaginary[i] = imaginary[reversed]; imaginary[reversed] = temporary;
        }
    }
    for (width = 2; width <= FFT_SIZE; width *= 2) {
        size_t start, j, half = width / 2;
        double angle = -2 * PI / width, step_r = cos(angle), step_i = sin(angle);
        for (start = 0; start < FFT_SIZE; start += width) {
            double r = 1, im = 0;
            for (j = 0; j < half; ++j) {
                size_t a = start + j, b = a + half;
                double br = r * real[b] - im * imaginary[b], bi = r * imaginary[b] + im * real[b];
                double next = r * step_r - im * step_i;
                real[b] = real[a] - br; imaginary[b] = imaginary[a] - bi;
                real[a] += br; imaginary[a] += bi;
                im = r * step_i + im * step_r; r = next;
            }
        }
    }
}
static double db(double power) { return 10 * log10(power > 1e-16 ? power : 1e-16); }
static double hz(double bin) { return bin * FS / FFT_SIZE; }
static int power_order(const void *a, const void *b) {
    const Peak *x = a, *y = b;
    if (x->power != y->power) return x->power > y->power ? -1 : 1;
    return y->bin - x->bin;
}
static Peaks detect(const double *power) {
    Peak candidates[MAX_PEAKS];
    int accepted[MAX_PEAKS], count = 0, keep = 0, i, j;
    Peaks result;
    result.count = 0;
    for (i = 1; i < BINS - 1; ++i) {
        int right = i;
        if (power[i] <= power[i - 1]) continue;
        while (right < BINS - 1 && power[right + 1] == power[i]) ++right;
        if (right < BINS - 1 && power[right] > power[right + 1]) {
            int center = (i + right) / 2;
            memset(&candidates[count], 0, sizeof(Peak));
            candidates[count].bin = center; candidates[count++].power = power[center];
        }
        i = right;
    }
    qsort(candidates, count, sizeof(Peak), power_order);
    /* scipy.signal.find_peaks applies distance suppression before prominence. */
    for (i = 0; i < count; ++i) {
        int allowed = 1;
        for (j = 0; j < keep; ++j) if (abs(candidates[i].bin - candidates[accepted[j]].bin) < minimum_distance_bins) allowed = 0;
        if (allowed) accepted[keep++] = i;
    }
    for (i = 0; i < keep; ++i) {
        Peak peak = candidates[accepted[i]];
        double minimum_left = peak.power, minimum_right = peak.power, level, crossing;
        int left = peak.bin, right = peak.bin;
        peak.left_base = peak.right_base = peak.bin;
        for (j = peak.bin; j >= 0 && power[j] <= peak.power; --j) {
            if (power[j] < minimum_left) { minimum_left = power[j]; peak.left_base = j; }
        }
        for (j = peak.bin; j < BINS && power[j] <= peak.power; ++j) {
            if (power[j] < minimum_right) { minimum_right = power[j]; peak.right_base = j; }
        }
        peak.prominence = db(peak.power) - MAXIMUM(db(minimum_left), db(minimum_right));
        if (peak.prominence < minimum_prominence) continue;
        level = peak.power - .5 * (peak.power - MAXIMUM(minimum_left, minimum_right));
        while (left > peak.left_base && power[left] > level) --left;
        crossing = left;
        if (power[left] < level) crossing += (level - power[left]) / (power[left + 1] - power[left]);
        peak.low = hz(crossing);
        while (right < peak.right_base && power[right] > level) ++right;
        crossing = right;
        if (power[right] < level) crossing -= (level - power[right]) / (power[right - 1] - power[right]);
        peak.high = hz(crossing);
        result.peaks[result.count++] = peak;
    }
    /* Highest linear PSD first, as in the earlier offline exploration. */
    return result;
}
static Analysis analyze(const double *samples, size_t count) {
    Analysis result;
    double window[FFT_SIZE], energy = 0;
    size_t i, frame;
    memset(&result, 0, sizeof(result));
    if (count < FFT_SIZE) fail("analysis interval shorter than one frame");
    result.samples = count; result.frames = 1 + (count - FFT_SIZE) / HOP;
    result.frames_psd = allocate(result.frames, BINS * sizeof(double));
    result.frame_peaks = allocate(result.frames, sizeof(Peaks));
    for (i = 0; i < FFT_SIZE; ++i) { window[i] = .5 - .5 * cos(2 * PI * i / FFT_SIZE); energy += window[i] * window[i]; }
    for (frame = 0; frame < result.frames; ++frame) {
        double real[FFT_SIZE], imaginary[FFT_SIZE], mean = 0;
        double *power = result.frames_psd + frame * BINS;
        for (i = 0; i < FFT_SIZE; ++i) mean += samples[frame * HOP + i];
        mean /= FFT_SIZE;
        for (i = 0; i < FFT_SIZE; ++i) { real[i] = (samples[frame * HOP + i] - mean) * window[i]; imaginary[i] = 0; }
        fft(real, imaginary);
        for (i = 0; i < BINS; ++i) {
            double factor = i == 0 || i == BINS - 1 ? 1 : 2;
            power[i] = factor * (real[i] * real[i] + imaginary[i] * imaginary[i]) / (FS * energy);
            result.psd[i] += power[i] / result.frames;
        }
        result.frame_peaks[frame] = detect(power);
    }
    result.average = detect(result.psd);
    return result;
}
static void release(Analysis *analysis) { free(analysis->frames_psd); free(analysis->frame_peaks); free(analysis->tracks); }
static void vector(FILE *file, const double *values, size_t count, int logarithmic) {
    size_t i;
    fputc('[', file);
    for (i = 0; i < count; ++i) fprintf(file, "%s%.12g", i ? "," : "", logarithmic ? db(values[i]) : values[i]);
    fputc(']', file);
}
static void write_peak(FILE *file, const Peak *peak, int id) {
    fprintf(file, "{\"id\":\"p%d\",\"frequency_hz\":%.12g,\"magnitude_db\":%.12g,\"prominence_db\":%.12g,"
        "\"bandwidth_hz\":%.12g,\"low_hz\":%.12g,\"high_hz\":%.12g}", id, hz(peak->bin), db(peak->power),
        peak->prominence, peak->high - peak->low, peak->low, peak->high);
}
static void write_peaks(FILE *file, const Peaks *peaks) {
    int i, count = peaks->count < TOP_PEAKS ? peaks->count : TOP_PEAKS;
    fputc('[', file);
    for (i = 0; i < count; ++i) { if (i) fputc(',', file); write_peak(file, &peaks->peaks[i], i + 1); }
    fputc(']', file);
}
static int pair_order(const void *a, const void *b) {
    const Pair *x = a, *y = b;
    if (x->distance != y->distance) return x->distance < y->distance ? -1 : 1;
    if (x->previous != y->previous) return x->previous - y->previous;
    return x->current - y->current;
}
static const Track *near_track(const Analysis *analysis, double frequency, double tolerance) {
    const Track *best = NULL;
    double closest = DBL_MAX;
    for (int i = 0; i < analysis->track_count; ++i) {
        const Track *track = &analysis->tracks[i];
        double delta = fabs(track->sum / track->count - frequency);
        if (delta <= tolerance && (!best || track->count > best->count || (track->count == best->count && delta < closest))) {
            best = track; closest = delta;
        }
    }
    return best;
}
static void write_track_id(FILE *file, const Analysis *analysis, double frequency, double width) {
    const Track *track = near_track(analysis, frequency, MAXIMUM(minimum_match_bins * FS / FFT_SIZE, width * match_width_fraction));
    if (track) fprintf(file, "%d", track->id); else fputs("null", file);
}
static int *build_tracking(Analysis *analysis, size_t begin, size_t end, int *eligible_frames) {
    size_t frame, capacity = analysis->frames * MAX_PEAKS;
    Track *tracks = allocate(capacity, sizeof(Track));
    int *ids = allocate(capacity, sizeof(int));
    Pair *pairs = allocate(MAX_PEAKS * MAX_PEAKS, sizeof(Pair));
    int previous_ids[MAX_PEAKS], previous_count = 0, track_count = 0;
    *eligible_frames = 0;
    /* Each point belongs to one uninterrupted, one-to-one trajectory. No gap filling. */
    for (frame = 0; frame < analysis->frames; ++frame) {
        const Peaks *current = &analysis->frame_peaks[frame];
        int current_ids[MAX_PEAKS], used_previous[MAX_PEAKS], used_current[MAX_PEAKS];
        int count = 0, p, q, k;
        size_t center = frame * HOP + FFT_SIZE / 2;
        memset(used_previous, 0, sizeof(used_previous)); memset(used_current, 0, sizeof(used_current));
        if (center >= begin && center < end) ++*eligible_frames;
        if (frame) {
            const Peaks *previous = &analysis->frame_peaks[frame - 1];
            for (p = 0; p < previous_count; ++p) for (q = 0; q < current->count; ++q) {
                double distance = fabs(hz(previous->peaks[p].bin) - hz(current->peaks[q].bin));
                double tolerance = MAXIMUM(minimum_match_bins * FS / FFT_SIZE, (previous->peaks[p].high - previous->peaks[p].low) * match_width_fraction);
                if (distance <= tolerance) { pairs[count].previous = p; pairs[count].current = q; pairs[count++].distance = distance; }
            }
        }
        qsort(pairs, count, sizeof(Pair), pair_order);
        for (k = 0; k < count; ++k) {
            p = pairs[k].previous; q = pairs[k].current;
            if (!used_previous[p] && !used_current[q]) {
                current_ids[q] = previous_ids[p]; used_previous[p] = used_current[q] = 1;
            }
        }
        for (q = 0; q < current->count; ++q) {
            Track *track;
            double frequency = hz(current->peaks[q].bin);
            if (!used_current[q]) {
                current_ids[q] = track_count;
                tracks[track_count].id = track_count + 1; tracks[track_count].first = (int)frame; ++track_count;
            }
            track = &tracks[current_ids[q]];
            track->last = (int)frame; ++track->count; track->sum += frequency; track->square += frequency * frequency;
            track->width_sum += current->peaks[q].high - current->peaks[q].low;
            ids[frame * MAX_PEAKS + q] = current_ids[q];
            previous_ids[q] = current_ids[q];
        }
        previous_count = current->count;
    }
    analysis->tracks = tracks; analysis->track_count = track_count;
    free(pairs);
    return ids;
}
static void write_tracking(FILE *file, Analysis *analysis, size_t begin, size_t end) {
    int eligible_frames = 0;
    int *ids = build_tracking(analysis, begin, end, &eligible_frames);
    Track *tracks = analysis->tracks;
    int track_count = analysis->track_count;
    size_t frame;
    fprintf(file, "{\"method\":\"adjacent-frame nearest-frequency one-to-one; no gap filling\",\"frame_count\":%lu,"
        "\"interval_frame_count\":%d,\"tracks\":[", (unsigned long)analysis->frames, eligible_frames);
    for (int k = 0; k < track_count; ++k) {
        Track *track = &tracks[k];
        double mean = track->sum / track->count, variance = track->square / track->count - mean * mean;
        double interval_sum = 0, interval_square = 0, interval_width = 0;
        int interval_count = 0, point_count = 0;
        if (k) fputc(',', file);
        fprintf(file, "{\"id\":%d,\"count\":%d,\"mean_hz\":%.12g,\"std_hz\":%.12g,\"mean_width_hz\":%.12g,"
            "\"appearance_percent\":%.12g,\"start_sec\":%.12g,\"end_sec\":%.12g,\"points\":[", track->id,
            track->count, mean, sqrt(MAXIMUM(0, variance)), track->width_sum / track->count,
            100.0 * track->count / analysis->frames, track->first * (double)HOP / FS,
            (track->last * (double)HOP + FFT_SIZE) / FS);
        for (frame = track->first; frame <= (size_t)track->last; ++frame) {
            const Peaks *peaks = &analysis->frame_peaks[frame];
            for (int q = 0; q < peaks->count; ++q) if (ids[frame * MAX_PEAKS + q] == k) {
                const Peak *peak = &peaks->peaks[q];
                double frequency = hz(peak->bin), width = peak->high - peak->low;
                size_t center = frame * HOP + FFT_SIZE / 2;
                fprintf(file, "%s[%lu,%.12g,%.12g]", point_count++ ? "," : "", (unsigned long)frame, frequency, width);
                if (center >= begin && center < end) {
                    ++interval_count; interval_sum += frequency; interval_square += frequency * frequency; interval_width += width;
                }
            }
        }
        fprintf(file, "],\"interval\":{\"count\":%d,\"appearance_percent\":%.12g,\"mean_hz\":", interval_count,
            eligible_frames ? 100.0 * interval_count / eligible_frames : 0);
        if (interval_count) {
            mean = interval_sum / interval_count;
            fprintf(file, "%.12g,\"std_hz\":%.12g,\"mean_width_hz\":%.12g", mean,
                sqrt(MAXIMUM(0, interval_square / interval_count - mean * mean)), interval_width / interval_count);
        } else fprintf(file, "null,\"std_hz\":null,\"mean_width_hz\":null");
        fputs("}}", file);
    }
    analysis->tracks = tracks; analysis->track_count = track_count;
    fputs("],\"peak_track_ids\":[", file);
    for (int i = 0; i < analysis->average.count && i < TOP_PEAKS; ++i) {
        const Peak *peak = &analysis->average.peaks[i];
        if (i) fputc(',', file);
        write_track_id(file, analysis, hz(peak->bin), peak->high - peak->low);
    }
    fputs("]}", file);
    free(ids);
}
static void write_analysis(FILE *file, Analysis *analysis, size_t begin, size_t end) {
    size_t frame;
    fputs("{\"psd_db\":", file); vector(file, analysis->psd, BINS, 1);
    fputs(",\"peaks\":", file); write_peaks(file, &analysis->average);
    fprintf(file, ",\"frame_count\":%lu,\"times_sec\":[", (unsigned long)analysis->frames);
    for (frame = 0; frame < analysis->frames; ++frame) fprintf(file, "%s%.12g", frame ? "," : "", (frame * (double)HOP + FFT_SIZE / 2) / FS);
    fputs("],\"spectrogram_db\":[", file);
    for (frame = 0; frame < analysis->frames; ++frame) {
        if (frame) fputc(',', file); vector(file, analysis->frames_psd + frame * BINS, BINS, 1);
    }
    fputs("],\"tracking\":", file); write_tracking(file, analysis, begin, end); fputc('}', file);
}
static double band_power(const double *power, double low, double high) {
    double total = 0;
    for (int i = 0; i < BINS; ++i) if (hz(i) >= low && hz(i) <= high) total += power[i];
    return total;
}
static const Peak *nearest(const Peaks *peaks, double frequency, double tolerance) {
    const Peak *result = NULL;
    double distance = DBL_MAX;
    for (int i = 0; i < peaks->count; ++i) {
        double delta = fabs(hz(peaks->peaks[i].bin) - frequency);
        if (delta <= tolerance && (delta < distance || (delta == distance && result && peaks->peaks[i].bin < result->bin))) { distance = delta; result = &peaks->peaks[i]; }
    }
    return result;
}
static void write_observations(FILE *file, const char *path, const Analysis *mixture, const Analysis *speech, const Analysis *noise) {
    FILE *anchors = fopen(path, "rb");
    Anchor anchor;
    int first = 1, read;
    if (!anchors) fail("cannot read source anchors");
    fputc('[', file);
    while ((read = fscanf(anchors, "%d,%lf,%lf,%lf,%lf", &anchor.id, &anchor.frequency, &anchor.width, &anchor.low, &anchor.high)) == 5) {
        const Peak *match, *speech_peak;
        double tolerance;
        if (anchor.id < 1 || anchor.id > 8 || !isfinite(anchor.frequency) || !isfinite(anchor.width) ||
            !isfinite(anchor.low) || !isfinite(anchor.high) || anchor.low < 0 || anchor.high > FS / 2 ||
            anchor.low >= anchor.high || anchor.frequency < anchor.low || anchor.frequency > anchor.high || anchor.width <= 0)
            fail("invalid source anchor");
        tolerance = MAXIMUM(minimum_match_bins * FS / FFT_SIZE, anchor.width * match_width_fraction);
        match = nearest(&mixture->average, anchor.frequency, tolerance);
        speech_peak = nearest(&speech->average, anchor.frequency, tolerance);
        fprintf(file, "%s{\"peak_id\":\"p%d\",\"mixture_frequency_hz\":", first ? "" : ",", anchor.id); first = 0;
        if (match) fprintf(file, "%.12g", hz(match->bin)); else fputs("null", file);
        fputs(",\"mixture_width_hz\":", file);
        if (match) fprintf(file, "%.12g", match->high - match->low); else fputs("null", file);
        fprintf(file, ",\"speech_peak_present\":%s,\"speech_to_noise_db\":%.12g,\"mixture_track_id\":", speech_peak ? "true" : "false",
            db(band_power(speech->psd, anchor.low, anchor.high)) - db(band_power(noise->psd, anchor.low, anchor.high)));
        write_track_id(file, mixture, anchor.frequency, anchor.width);
        fputs(",\"noise_track_id\":", file); write_track_id(file, noise, anchor.frequency, anchor.width);
        fputs(",\"speech_track_id\":", file); write_track_id(file, speech, anchor.frequency, anchor.width); fputc('}', file);
    }
    if (read != EOF) fail("malformed anchor file");
    fclose(anchors); fputc(']', file);
}
static size_t sample_index(const char *text) {
    char *end;
    unsigned long value;
    errno = 0;
    if (!*text || *text == '-') fail("invalid sample index");
    value = strtoul(text, &end, 10);
    if (errno || *end) fail("invalid sample index");
    return (size_t)value;
}
static double positive_number(const char *text) {
    char *end;
    double value;
    errno = 0; value = strtod(text, &end);
    if (errno || !*text || *end || !isfinite(value) || value <= 0) fail("expected a positive finite parameter");
    return value;
}
#include "mixture_summary.h"
#include "peak_periods.h"

int main(int argc, char **argv) {
    const char *input = NULL, *reference = NULL, *output = NULL, *anchors = NULL;
    const char *start_text = NULL, *end_text = NULL;
    const char *summary_manifest = NULL, *split_text = NULL, *period_manifest = NULL;
    Wave signal, clean = {0, NULL};
    Analysis measured, speech, noise;
    double *added = NULL;
    FILE *file, *existing;
    size_t start = 0, end;
    if (argc < 5 || !(argc & 1)) fail("usage: --input WAV --output JSON [--reference WAV --start-sample N --end-sample N --anchors CSV]");
    for (int i = 1; i < argc; i += 2) {
        const char **target = NULL;
        if (!strcmp(argv[i], "--prominence-db")) { minimum_prominence = positive_number(argv[i + 1]); continue; }
        if (!strcmp(argv[i], "--distance-bins")) {
            double value = positive_number(argv[i + 1]);
            if (value != floor(value) || value > BINS) fail("invalid minimum bin distance");
            minimum_distance_bins = (int)value; continue;
        }
        if (!strcmp(argv[i], "--match-min-bins")) { minimum_match_bins = positive_number(argv[i + 1]); continue; }
        if (!strcmp(argv[i], "--match-width-fraction")) { match_width_fraction = positive_number(argv[i + 1]); continue; }
        if (!strcmp(argv[i], "--input")) target = &input;
        else if (!strcmp(argv[i], "--output")) target = &output;
        else if (!strcmp(argv[i], "--reference")) target = &reference;
        else if (!strcmp(argv[i], "--start-sample")) target = &start_text;
        else if (!strcmp(argv[i], "--end-sample")) target = &end_text;
        else if (!strcmp(argv[i], "--anchors")) target = &anchors;
        else if (!strcmp(argv[i], "--summary-manifest")) target = &summary_manifest;
        else if (!strcmp(argv[i], "--split-sample")) target = &split_text;
        else if (!strcmp(argv[i], "--peak-periods-manifest")) target = &period_manifest;
        if (!target || *target) fail("unknown or duplicate argument");
        *target = argv[i + 1];
    }
    if (period_manifest) {
        if (!output || !anchors || input || reference || start_text || end_text || summary_manifest || split_text) fail("invalid period arguments");
        existing = fopen(output, "rb");
        if (existing) { fclose(existing); fail("output exists; select a new result path"); }
        analyze_peak_periods(period_manifest, anchors, output);
        return EXIT_SUCCESS;
    }
    if (summary_manifest) {
        if (!output || !anchors || input || reference || start_text || end_text) fail("invalid summary arguments");
        existing = fopen(output, "rb");
        if (existing) { fclose(existing); fail("output exists; select a new result path"); }
        summarize_mixtures(summary_manifest, anchors, output, split_text ? sample_index(split_text) : 0);
        return EXIT_SUCCESS;
    }
    if (split_text || !input || !output || ((reference != NULL) != (anchors != NULL)) ||
        ((start_text != NULL) != (end_text != NULL)) || (reference && !start_text)) fail("missing paired arguments");
    existing = fopen(output, "rb");
    if (existing) { fclose(existing); fail("output exists; select a new result path"); }
    signal = read_wave(input); end = signal.count;
    if (start_text) { start = sample_index(start_text); end = sample_index(end_text); }
    if (start >= end || end > signal.count) fail("invalid measurement interval");
    measured = analyze(signal.samples, signal.count);
    if (reference) {
        clean = read_wave(reference);
        if (signal.count != clean.count) fail("reference length mismatch");
        added = allocate(signal.count, sizeof(double));
        for (size_t i = 0; i < signal.count; ++i) added[i] = signal.samples[i] - clean.samples[i];
        speech = analyze(clean.samples, clean.count); noise = analyze(added, signal.count);
    }
    file = fopen(output, "wb"); if (!file) fail("cannot create result JSON");
    fprintf(file, "{\"version\":1,\"tool_version\":\"%s\",\"sample_rate_hz\":%d,\"sample_count\":%lu,"
        "\"nperseg\":%d,\"hop\":%d,\"signal\":", TOOL, FS, (unsigned long)signal.count, FFT_SIZE, HOP);
    write_analysis(file, &measured, start, end);
    if (reference) {
        double voice_energy = 0, noise_energy = 0;
        for (size_t i = start; i < end; ++i) { voice_energy += clean.samples[i] * clean.samples[i]; noise_energy += added[i] * added[i]; }
        fprintf(file, ",\"interval_sec\":[%.12g,%.12g],\"actual_snr_db\":%.12g,\"speech\":", (double)start / FS,
            (double)end / FS, db(voice_energy / (end - start)) - db(noise_energy / (end - start)));
        write_analysis(file, &speech, start, end); fputs(",\"added_noise\":", file); write_analysis(file, &noise, start, end);
        fputs(",\"observations\":", file); write_observations(file, anchors, &measured, &speech, &noise);
        release(&speech); release(&noise);
    } else {
        const int boundaries[] = {0, 100, 300, 1000, 2000, 4000, 8000};
        double total = 0;
        for (int i = 0; i < BINS; ++i) total += measured.psd[i];
        fputs(",\"band_energy\":[", file);
        for (int band = 0; band < 6; ++band) {
            double sum = 0;
            for (int i = 0; i < BINS; ++i) if (hz(i) >= boundaries[band] &&
                (band == 5 ? hz(i) <= boundaries[band + 1] : hz(i) < boundaries[band + 1])) sum += measured.psd[i];
            fprintf(file, "%s{\"low_hz\":%d,\"high_hz\":%d,\"energy_percent\":%.12g}", band ? "," : "",
                boundaries[band], boundaries[band + 1], total ? 100 * sum / total : 0);
        }
        fputc(']', file);
        if (signal.count >= 40000 + FFT_SIZE) {
            Analysis before = analyze(signal.samples, 40000), after = analyze(signal.samples + 40000, signal.count - 40000);
            fputs(",\"before_psd_db\":", file); vector(file, before.psd, BINS, 1);
            fputs(",\"after_psd_db\":", file); vector(file, after.psd, BINS, 1);
            fputs(",\"time_change_db\":[", file);
            for (int i = 0; i < measured.average.count && i < TOP_PEAKS; ++i) {
                const Peak *peak = &measured.average.peaks[i];
                fprintf(file, "%s%.12g", i ? "," : "", db(band_power(after.psd, peak->low, peak->high)) - db(band_power(before.psd, peak->low, peak->high)));
            }
            fputc(']', file); release(&before); release(&after);
        }
    }
    fputs("}\n", file);
    if (ferror(file) || fclose(file)) fail("cannot write completed JSON");
    release(&measured); free(signal.samples); free(clean.samples); free(added);
    return EXIT_SUCCESS;
}
