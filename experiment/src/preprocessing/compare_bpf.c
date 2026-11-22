/* Compare exact digital Butterworth BP magnitude responses with stored C PSDs.
 * With prewarped t=tan(pi*f/fs), L=tan(pi*fl/fs), U=tan(pi*fh/fs),
 * the lowpass prototype variable is (t*t-L*U)/(t*(U-L)).
 * No WAV, phase correction, audio generation or final parameter selection.
 */
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define PI 3.14159265358979323846264338327950288
#define MAX_BINS 8193
#define MAX_CANDIDATES 1024
#define MAX_CASES 1024
typedef struct { char id[80]; double low, high; int order; } Candidate;
typedef struct {
    char id[100]; int kind, has_speech;
    double *mix, *speech, *noise, total[3];
} Case;
typedef struct { double sum, min, max; int count; } Stats;
static void fail(const char *s) { fprintf(stderr, "BPF comparison failed: %s\n", s); exit(1); }
static void *allocate(size_t count, size_t size) {
    void *p = calloc(count, size); if (!p) fail("allocation failed"); return p;
}
static void add(Stats *s, double value) {
    if (!isfinite(value)) fail("non-finite statistic");
    if (!s->count || value < s->min) s->min = value;
    if (!s->count || value > s->max) s->max = value;
    s->sum += value; ++s->count;
}
static double power_gain(double f, double fs, Candidate c) {
    double t, low, high, mapped, power;
    if (f == 0 || f == fs / 2) return 0;
    t = tan(PI * f / fs); low = tan(PI * c.low / fs); high = tan(PI * c.high / fs);
    mapped = fabs((t * t - low * high) / (t * (high - low)));
    power = pow(mapped, 2 * c.order);
    return 1 / (1 + power);
}
static void write_stats(FILE *f, const char *key, Stats s) {
    if (!s.count) fail("no individual conditions");
    fprintf(f, "\"%s\":{\"mean\":%.17g,\"min\":%.17g,\"max\":%.17g}", key, s.sum / s.count, s.min, s.max);
}
int main(int argc, char **argv) {
    FILE *input, *cases_file, *responses, *summary;
    Candidate *candidates; Case *cases;
    double fs, *frequencies, *gains;
    int bins, nc, ns, i, j, k;
    char magic[40], extra[2];
    if (argc != 5) fail("usage: INPUT.txt CASES.csv RESPONSES.csv SUMMARY.json");
    for (i = 1; i < argc; ++i) for (j = i + 1; j < argc; ++j)
        if (!strcmp(argv[i], argv[j])) fail("input and output paths must differ");
    for (i = 2; i < argc; ++i) {
        FILE *existing = fopen(argv[i], "rb");
        if (existing) { fclose(existing); fail("outputs must not exist"); }
    }
    input = fopen(argv[1], "rb"); if (!input) fail("cannot open input");
    if (fscanf(input, "%39s%lf%d%d%d", magic, &fs, &bins, &nc, &ns) != 5 || strcmp(magic, "CNR_BPF_COMPARE_1") ||
        fs != 16000 || bins < 3 || bins > MAX_BINS || nc < 1 || nc > MAX_CANDIDATES || ns < 1 || ns > MAX_CASES) fail("invalid header");
    frequencies = allocate(bins, sizeof(double)); gains = allocate(bins, sizeof(double));
    candidates = allocate(nc, sizeof(Candidate)); cases = allocate(ns, sizeof(Case));
    for (i = 0; i < bins; ++i)
        if (fscanf(input, "%lf", &frequencies[i]) != 1 || !isfinite(frequencies[i]) || frequencies[i] < 0 ||
            frequencies[i] > fs / 2 || (i && frequencies[i] <= frequencies[i - 1])) fail("invalid frequency grid");
    for (i = 0; i < nc; ++i) {
        Candidate *c = &candidates[i];
        if (fscanf(input, "%79s%lf%lf%d", c->id, &c->low, &c->high, &c->order) != 4 || !isfinite(c->low) || !isfinite(c->high) ||
            !(c->low > 0 && c->low < c->high && c->high < fs / 2) || c->order < 1 || c->order > 16) fail("invalid candidate");
        if (strspn(c->id, "abcdefghijklmnopqrstuvwxyz0123456789_") != strlen(c->id)) fail("invalid candidate ID");
        for (j = 0; j < i; ++j) if (!strcmp(c->id, candidates[j].id)) fail("duplicate candidate ID");
    }
    for (i = 0; i < ns; ++i) {
        Case *c = &cases[i]; double *arrays[3];
        if (fscanf(input, "%99s%d%d", c->id, &c->kind, &c->has_speech) != 3 || c->kind < 0 || c->kind > 2 ||
            c->has_speech < 0 || c->has_speech > 1 || (c->kind == 2 && !c->has_speech)) fail("invalid comparison case");
        if (strspn(c->id, "abcdefghijklmnopqrstuvwxyz0123456789_") != strlen(c->id)) fail("invalid case ID");
        c->mix = allocate(bins, sizeof(double)); c->speech = allocate(bins, sizeof(double)); c->noise = allocate(bins, sizeof(double));
        arrays[0] = c->mix; arrays[1] = c->speech; arrays[2] = c->noise;
        for (j = 0; j < 3; ++j) for (k = 0; k < bins; ++k) {
            double db, power;
            if (fscanf(input, "%lf", &db) != 1 || !isfinite(db)) fail("invalid saved PSD");
            power = pow(10, db / 10);
            if (!isfinite(power)) fail("PSD overflow");
            arrays[j][k] = power; c->total[j] += power;
        }
        if (!(c->total[0] > 0 && c->total[2] > 0) || (c->has_speech && !(c->total[1] > 0))) fail("zero signal power");
    }
    if (fscanf(input, "%1s", extra) == 1) fail("unexpected input data");
    fclose(input);
    cases_file = fopen(argv[2], "wb"); responses = fopen(argv[3], "wb"); summary = fopen(argv[4], "wb");
    if (!cases_file || !responses || !summary) fail("cannot create output files");
    fprintf(cases_file, "candidate_id,case_id,clean_retained_percent,noise_reduction_db,mixture_reduction_db,snr_change_db\n");
    fprintf(responses, "candidate_id,frequency_hz,power_gain\n");
    fprintf(summary, "{\"tool_version\":\"cnr-bpf-comparison/1\",\"sample_rate_hz\":16000,\"frequency_bins\":%d,\"case_count\":%d,\"candidate_count\":%d,\"candidates\":[", bins, ns, nc);
    for (i = 0; i < nc; ++i) {
        Candidate candidate = candidates[i]; Stats speech = {0}, noise = {0}, snr = {0}, mix = {0};
        for (k = 0; k < bins; ++k) {
            gains[k] = power_gain(frequencies[k], fs, candidate);
            fprintf(responses, "%s,%.17g,%.17g\n", candidate.id, frequencies[k], gains[k]);
        }
        for (j = 0; j < ns; ++j) {
            Case c = cases[j]; double retained[3] = {0}, clean_percent = 0, noise_drop, mix_drop, speech_drop = 0, snr_change = 0;
            for (k = 0; k < bins; ++k) { retained[0] += c.mix[k] * gains[k]; retained[1] += c.speech[k] * gains[k]; retained[2] += c.noise[k] * gains[k]; }
            if (!(retained[0] > 0 && retained[2] > 0)) fail("no retained signal power");
            noise_drop = -10 * log10(retained[2] / c.total[2]); mix_drop = -10 * log10(retained[0] / c.total[0]);
            if (c.has_speech) {
                clean_percent = 100 * retained[1] / c.total[1];
                speech_drop = -10 * log10(retained[1] / c.total[1]); snr_change = noise_drop - speech_drop;
                fprintf(cases_file, "%s,%s,%.17g,%.17g,%.17g,%.17g\n", candidate.id, c.id, clean_percent, noise_drop, mix_drop, snr_change);
            } else fprintf(cases_file, "%s,%s,,%.17g,%.17g,\n", candidate.id, c.id, noise_drop, mix_drop);
            if (c.kind == 2) { add(&speech, clean_percent); add(&noise, noise_drop); add(&snr, snr_change); add(&mix, mix_drop); }
        }
        if (i) fputc(',', summary);
        fprintf(summary, "{\"id\":\"%s\",\"lower_hz\":%.17g,\"upper_hz\":%.17g,\"prototype_order\":%d,\"digital_order\":%d,\"individual_count\":%d,", candidate.id, candidate.low, candidate.high, candidate.order, 2 * candidate.order, speech.count);
        write_stats(summary, "clean_retained_percent", speech); fputc(',', summary);
        write_stats(summary, "noise_reduction_db", noise); fputc(',', summary);
        write_stats(summary, "snr_change_db", snr); fputc(',', summary);
        write_stats(summary, "mixture_reduction_db", mix); fputc('}', summary);
    }
    fprintf(summary, "],\"method\":\"PSD-weighted exact single-pass digital Butterworth BP power response; whole-interval SNR change, not labeled active-speech SNR or intelligibility\"}\n");
    if (ferror(cases_file) || ferror(responses) || ferror(summary)) fail("cannot write results");
    if (fclose(cases_file) || fclose(responses) || fclose(summary)) fail("cannot close results");
    for (i = 0; i < ns; ++i) { free(cases[i].mix); free(cases[i].speech); free(cases[i].noise); }
    free(cases); free(candidates); free(frequencies); free(gains);
    return 0;
}
