/* New research measurements reuse the verified WAV reader and FFT, without
 * invoking legacy peak thresholds, tracking, or automatic interval splits. */
#define main cnr_legacy_main
#include "analyze_signals.c"
#undef main

#define RESEARCH_TOOL "cnr-research-analysis/1"
typedef struct {
    size_t frames, selected, before_count, after_count;
    double *powers, *rms;
    double whole[BINS], primary[BINS], before[BINS], after[BINS];
} ResearchSpectrum;

static void number(FILE *f, double v) {
    if (isfinite(v)) fprintf(f, "%.17g", v); else fputs("null", f);
}
static void numbers(FILE *f, const double *v, size_t n, int logscale) {
    fputc('[', f);
    for (size_t i = 0; i < n; ++i) {
        double value = v[i];
        if (i) fputc(',', f);
        if (logscale) value = value > 0 ? 10 * log10(value) : NAN;
        number(f, value);
    }
    fputc(']', f);
}
static double sum_power(const double *p) {
    double total = 0;
    for (int b = 0; b < BINS; ++b) total += p[b];
    return total;
}
static double energy(const double *p, size_t start, size_t end) {
    double value = 0;
    for (size_t i = start; i < end; ++i) value += p[i] * p[i];
    return value;
}
static double ratio_db(double numerator, double denominator) {
    return numerator > 0 && denominator > 0 ? 10 * log10(numerator / denominator) : NAN;
}
static ResearchSpectrum measure(const double *samples, size_t count, size_t start, size_t end, size_t split) {
    ResearchSpectrum r;
    double window[FFT_SIZE], window_power = 0;
    memset(&r, 0, sizeof(r));
    if (count < FFT_SIZE || start >= end || end > count) fail("invalid research interval");
    r.frames = 1 + (count - FFT_SIZE) / HOP;
    r.powers = allocate(r.frames, BINS * sizeof(double));
    r.rms = allocate(r.frames, sizeof(double));
    for (int i = 0; i < FFT_SIZE; ++i) {
        window[i] = .5 - .5 * cos(2 * PI * i / FFT_SIZE);
        window_power += window[i] * window[i];
    }
    for (size_t t = 0; t < r.frames; ++t) {
        size_t begin = t * HOP, stop = begin + FFT_SIZE;
        double real[FFT_SIZE], imaginary[FFT_SIZE], mean = 0;
        int selected = begin >= start && stop <= end;
        int before = split && stop <= split, after = split && begin >= split;
        double *p = r.powers + t * BINS;
        for (int i = 0; i < FFT_SIZE; ++i) mean += samples[begin + i];
        mean /= FFT_SIZE;
        r.rms[t] = sqrt(energy(samples, begin, stop) / FFT_SIZE);
        for (int i = 0; i < FFT_SIZE; ++i) {
            real[i] = (samples[begin + i] - mean) * window[i]; imaginary[i] = 0;
        }
        fft(real, imaginary);
        r.selected += selected; r.before_count += before; r.after_count += after;
        for (int b = 0; b < BINS; ++b) {
            double factor = b == 0 || b == BINS - 1 ? 1 : 2;
            p[b] = factor * (real[b] * real[b] + imaginary[b] * imaginary[b]) / (FS * window_power);
            r.whole[b] += p[b];
            if (selected) r.primary[b] += p[b];
            if (before) r.before[b] += p[b];
            if (after) r.after[b] += p[b];
        }
    }
    if (!r.selected || (split && (!r.before_count || !r.after_count))) fail("no complete frames in measurement interval");
    for (int b = 0; b < BINS; ++b) {
        r.whole[b] /= r.frames; r.primary[b] /= r.selected;
        if (r.before_count) r.before[b] /= r.before_count;
        if (r.after_count) r.after[b] /= r.after_count;
    }
    return r;
}
static void spectrum(FILE *f, const double *p, size_t frames) {
    double total = sum_power(p), cumulative[BINS], sum = 0;
    for (int b = 0; b < BINS; ++b) { sum += p[b]; cumulative[b] = total > 0 ? 100 * sum / total : NAN; }
    fprintf(f, "{\"frame_count\":%lu,\"total_power\":", (unsigned long)frames);
    number(f, total * FS / FFT_SIZE);
    fputs(",\"psd\":", f); numbers(f, p, BINS, 0);
    fputs(",\"psd_db\":", f); numbers(f, p, BINS, 1);
    fputs(",\"cumulative_percent\":", f); numbers(f, cumulative, BINS, 0); fputc('}', f);
}
static void write_measurement(FILE *f, const ResearchSpectrum *r, int keep_frames, size_t split, double gain) {
    fputs("{\"whole\":", f); spectrum(f, r->whole, r->frames);
    fputs(",\"primary\":", f); spectrum(f, r->primary, r->selected);
    double normalized[BINS];
    for (int b = 0; b < BINS; ++b) normalized[b] = isfinite(gain) ? r->primary[b] * gain * gain : 0;
    fputs(",\"normalized_primary\":", f); spectrum(f, normalized, r->selected);
    fputs(",\"times_sec\":[", f);
    for (size_t i = 0; i < r->frames; ++i) {
        if (i) fputc(',', f); number(f, (i * HOP + FFT_SIZE / 2.0) / FS);
    }
    fputs("],\"rms\":", f); numbers(f, r->rms, r->frames, 0);
    if (keep_frames) {
        fputs(",\"spectrogram_db\":[", f);
        for (size_t t = 0; t < r->frames; ++t) {
            if (t) fputc(',', f); numbers(f, r->powers + t * BINS, BINS, 1);
        }
        fputc(']', f);
    }
    if (split) {
        fputs(",\"before\":", f); spectrum(f, r->before, r->before_count);
        fputs(",\"after\":", f); spectrum(f, r->after, r->after_count);
        fputs(",\"change_db\":[", f);
        for (int b = 0; b < BINS; ++b) { if (b) fputc(',', f); number(f, ratio_db(r->after[b], r->before[b])); }
        fputc(']', f);
    }
    fputc('}', f);
}
static int double_order(const void *a, const void *b) {
    double x = *(const double *)a, y = *(const double *)b;
    return x < y ? -1 : x > y;
}
static double median(double *values, size_t n) {
    if (!n) return NAN;
    qsort(values, n, sizeof(double), double_order);
    return n % 2 ? values[n / 2] : (values[n / 2 - 1] + values[n / 2]) / 2;
}
static void write_paired(FILE *f, const Wave *mixture, const Wave *clean, const double *added,
                         const ResearchSpectrum *m, const ResearchSpectrum *n, size_t start, size_t end, size_t initial_limit) {
    double *snr = allocate(m->frames, sizeof(double)), *selected = allocate(m->frames, sizeof(double));
    size_t count = 0, zero_clean = 0, zero_noise = 0;
    double actual = ratio_db(energy(clean->samples, start, end), energy(added, start, end));
    fputs(",\"actual_snr_db\":", f); number(f, actual);
    for (size_t t = 0; t < m->frames; ++t) {
        size_t begin = t * HOP, stop = begin + FFT_SIZE;
        double s = energy(clean->samples, begin, stop), d = energy(added, begin, stop);
        snr[t] = ratio_db(s, d);
        if (begin >= start && stop <= end) {
            if (s == 0) ++zero_clean;
            if (d == 0) ++zero_noise;
            if (isfinite(snr[t])) selected[count++] = snr[t];
        }
    }
    fputs(",\"frame_snr_db\":", f); numbers(f, snr, m->frames, 0);
    fprintf(f, ",\"frame_snr_summary\":{\"valid\":%lu,\"zero_clean\":%lu,\"zero_noise\":%lu,\"median_db\":",
            (unsigned long)count, (unsigned long)zero_clean, (unsigned long)zero_noise);
    number(f, median(selected, count)); fputc('}', f);
    fputs(",\"initial_estimates\":[", f);
    double cumulative[BINS] = {0}, true_total = sum_power(n->primary);
    int emitted = 0;
    if (initial_limit > start || initial_limit > mixture->count) fail("initial interval overlaps registered speech");
    for (size_t t = 0; t < m->frames && (t * HOP + FFT_SIZE) <= initial_limit; ++t) {
        size_t stop = t * HOP + FFT_SIZE;
        double estimate[BINS], estimate_total = 0, shape = 0;
        double s = energy(clean->samples, 0, stop), d = energy(added, 0, stop);
        for (int b = 0; b < BINS; ++b) {
            cumulative[b] += m->powers[t * BINS + b]; estimate[b] = cumulative[b] / (t + 1);
            estimate_total += estimate[b];
        }
        if (estimate_total > 0 && true_total > 0) {
            for (int b = 0; b < BINS; ++b) shape += fabs(estimate[b] / estimate_total - n->primary[b] / true_total) / 2;
        } else shape = NAN;
        if (emitted++) fputc(',', f);
        fprintf(f, "{\"end_sample\":%lu,\"duration_sec\":", (unsigned long)stop); number(f, (double)stop / FS);
        fputs(",\"power_bias_db\":", f); number(f, ratio_db(estimate_total, true_total));
        fputs(",\"shape_tvd\":", f); number(f, shape);
        fputs(",\"speech_component_percent\":", f); number(f, s + d > 0 ? 100 * s / (s + d) : NAN); fputc('}', f);
    }
    fputc(']', f); free(snr); free(selected);
}
static void signal_job(const char *input, const char *reference, const char *output, size_t start, size_t end,
                       size_t split, size_t initial_limit, int keep_frames) {
    Wave signal = read_wave(input), clean = {0, NULL};
    double *added = NULL;
    if (!end) end = signal.count;
    if (start >= end || end > signal.count || (split && split >= signal.count)) fail("invalid signal interval");
    ResearchSpectrum a = measure(signal.samples, signal.count, start, end, split), b;
    if (reference) {
        clean = read_wave(reference);
        if (signal.count != clean.count) fail("reference length mismatch");
        added = allocate(signal.count, sizeof(double));
        for (size_t i = 0; i < signal.count; ++i) added[i] = signal.samples[i] - clean.samples[i];
        b = measure(added, signal.count, start, end, 0);
    }
    FILE *f = fopen(output, "wb"); if (!f) fail("cannot create research output");
    fprintf(f, "{\"version\":1,\"tool_version\":\"%s\",\"sample_rate_hz\":%d,\"nperseg\":%d,\"hop\":%d,\"sample_count\":%lu,\"start_sample\":%lu,\"end_sample\":%lu,\"reference_rms\":",
            RESEARCH_TOOL, FS, FFT_SIZE, HOP, (unsigned long)signal.count, (unsigned long)start, (unsigned long)end);
    double rms = sqrt(energy(reference ? clean.samples : signal.samples, start, end) / (end - start));
    double gain = rms > 0 ? 1 / rms : NAN;
    number(f, rms); fputs(",\"normalization_gain\":", f); number(f, gain);
    fputs(",\"signal\":", f); write_measurement(f, &a, keep_frames, split, gain);
    if (reference) {
        fputs(",\"added_noise\":", f); write_measurement(f, &b, 0, 0, gain);
        write_paired(f, &signal, &clean, added, &a, &b, start, end, initial_limit);
        free(b.powers); free(b.rms);
    }
    fputs("}\n", f); if (ferror(f) || fclose(f)) fail("research output write failed");
    free(a.powers); free(a.rms); free(added); free(signal.samples); free(clean.samples);
}

typedef struct { double mean, low, high; int count; } Summary;
static void update_summary(Summary *s, double value) {
    if (!isfinite(value)) return;
    if (!s->count || value < s->low) s->low = value;
    if (!s->count || value > s->high) s->high = value;
    s->mean += value; ++s->count;
}
static void write_summary(FILE *f, Summary s) {
    fprintf(f, "{\"count\":%d,\"mean\":", s.count); number(f, s.count ? s.mean / s.count : NAN);
    fputs(",\"min\":", f); number(f, s.count ? s.low : NAN);
    fputs(",\"max\":", f); number(f, s.count ? s.high : NAN); fputc('}', f);
}
static void group_job(const char *input, const char *output) {
    FILE *in = fopen(input, "rb"); if (!in) fail("cannot read group transport");
    char magic[40]; int count, bins, prefix_count = -1;
    if (fscanf(in, "%39s%d%d", magic, &count, &bins) != 3 || strcmp(magic, "CNR_RESEARCH_GROUP_1") || count < 1 || count > 12 || bins != BINS) fail("invalid group transport");
    double *means = allocate(6, BINS * sizeof(double));
    double *lows = allocate(6, BINS * sizeof(double)), *highs = allocate(6, BINS * sizeof(double));
    double member_medians[12]; Summary medians = {0};
    size_t *ends = NULL; Summary *prefix = NULL;
    for (int member = 0; member < count; ++member) {
        double gain; int valid, rows;
        if (fscanf(in, "%lf", &gain) != 1 || !isfinite(gain) || gain <= 0) fail("invalid normalization gain");
        for (int k = 0; k < 6; ++k) for (int b = 0; b < BINS; ++b) {
            double value;
            if (fscanf(in, "%lf", &value) != 1 || !isfinite(value) || value < 0) fail("invalid group PSD");
            value *= gain * gain;
            size_t index = k * BINS + b;
            means[index] += value / count;
            if (!member || value < lows[index]) lows[index] = value;
            if (!member || value > highs[index]) highs[index] = value;
        }
        if (fscanf(in, "%d%lf%d", &valid, &member_medians[member], &rows) != 3 || rows < 0 || rows > 10000) fail("invalid group scalar measurements");
        if (valid) update_summary(&medians, member_medians[member]); else member_medians[member] = NAN;
        if (prefix_count < 0) {
            prefix_count = rows; if (rows) { ends = allocate(rows, sizeof(size_t)); prefix = allocate(rows * 3, sizeof(Summary)); }
        }
        if (rows != prefix_count) fail("prefix grids differ between group members");
        for (int row = 0; row < rows; ++row) {
            unsigned long end; double a, b, c;
            if (fscanf(in, "%lu%lf%lf%lf", &end, &a, &b, &c) != 4) fail("invalid initial estimate row");
            if (member && ends[row] != end) fail("prefix endpoints differ");
            ends[row] = end; update_summary(&prefix[row * 3], a); update_summary(&prefix[row * 3 + 1], b); update_summary(&prefix[row * 3 + 2], c);
        }
    }
    char extra; if (fscanf(in, " %c", &extra) == 1) fail("unexpected group transport trailing data");
    fclose(in);
    FILE *f = fopen(output, "wb"); if (!f) fail("cannot write group output");
    fprintf(f, "{\"version\":1,\"tool_version\":\"%s\",\"member_count\":%d,\"nperseg\":%d,\"hop\":%d,\"signals\":{", RESEARCH_TOOL, count, FFT_SIZE, HOP);
    const char *names[] = {"speech", "added_noise", "mixture"};
    for (int k = 0; k < 3; ++k) {
        if (k) fputc(',', f); fprintf(f, "\"%s\":{\"primary\":", names[k]); spectrum(f, means + k * BINS, 0);
        fputs(",\"whole\":", f); spectrum(f, means + (k + 3) * BINS, 0);
        fputs(",\"min_db\":", f); numbers(f, lows + k * BINS, BINS, 1);
        fputs(",\"max_db\":", f); numbers(f, highs + k * BINS, BINS, 1); fputc('}', f);
    }
    fputs("},\"speech_noise_ratio_db\":[", f);
    for (int b = 0; b < BINS; ++b) { if (b) fputc(',', f); number(f, ratio_db(means[b], means[BINS + b])); }
    fputs("],\"frame_snr_member_medians_db\":", f); numbers(f, member_medians, count, 0);
    fputs(",\"frame_snr_summary\":", f); write_summary(f, medians);
    fputs(",\"initial_estimates\":[", f);
    for (int row = 0; row < prefix_count; ++row) {
        if (row) fputc(',', f); fprintf(f, "{\"end_sample\":%lu,\"duration_sec\":", (unsigned long)ends[row]); number(f, (double)ends[row] / FS);
        fputs(",\"power_bias_db\":", f); write_summary(f, prefix[row * 3]);
        fputs(",\"shape_tvd\":", f); write_summary(f, prefix[row * 3 + 1]);
        fputs(",\"speech_component_percent\":", f); write_summary(f, prefix[row * 3 + 2]); fputc('}', f);
    }
    fputs("]}\n", f); if (ferror(f) || fclose(f)) fail("group output write failed");
    free(means); free(lows); free(highs); free(ends); free(prefix);
}
int main(int argc, char **argv) {
    const char *input = NULL, *reference = NULL, *output = NULL, *group = NULL;
    size_t start = 0, end = 0, split = 0, initial = 0; int keep = 0;
    if (argc < 5 || !(argc & 1)) fail("expected paired research arguments");
    for (int i = 1; i < argc; i += 2) {
        const char *key = argv[i], *value = argv[i + 1];
        if (!strcmp(key, "--input") && !input) input = value;
        else if (!strcmp(key, "--reference") && !reference) reference = value;
        else if (!strcmp(key, "--output") && !output) output = value;
        else if (!strcmp(key, "--group") && !group) group = value;
        else if (!strcmp(key, "--start")) start = sample_index(value);
        else if (!strcmp(key, "--end")) end = sample_index(value);
        else if (!strcmp(key, "--split")) split = sample_index(value);
        else if (!strcmp(key, "--initial-limit")) initial = sample_index(value);
        else if (!strcmp(key, "--spectrogram") && (!strcmp(value, "0") || !strcmp(value, "1"))) keep = value[0] == '1';
        else fail("unknown or duplicate research argument");
    }
    if (!output || (!!input == !!group) || (group && (reference || start || end || split || initial || keep))) fail("invalid research arguments");
    FILE *exists = fopen(output, "rb"); if (exists) { fclose(exists); fail("output already exists"); }
    if (group) group_job(group, output); else signal_job(input, reference, output, start, end, split, initial, keep);
    return EXIT_SUCCESS;
}
