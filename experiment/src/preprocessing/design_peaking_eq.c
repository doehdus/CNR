/* Design-only RBJ peaking EQ: no WAV input or audio processing.
 * Q denotes half-gain bandwidth at the specified digital sample rate.
 * https://www.w3.org/TR/audio-eq-cookbook/
 */
#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#endif
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#ifdef _WIN32
#include <io.h>
#else
#include <unistd.h>
#endif

#define PI 3.14159265358979323846264338327950288
#define TOOL "cnr-peaking-eq-design/1"
#define GRID_STEP 0.5
#define GRID_COUNT 16007

typedef struct { double re, im; } Complex;
typedef struct {
    double center, width, requested_q, q, gain, b[3], a[3], edges[2];
    Complex poles[2];
} Section;

static void fail(const char *message) {
    fprintf(stderr, "EQ design failed: %s\n", message);
    exit(EXIT_FAILURE);
}
static double number(const char *value) {
    char *end;
    double result;
    errno = 0;
    result = strtod(value, &end);
    if (errno || end == value || *end || !isfinite(result)) fail("expected finite numeric parameter");
    return result;
}
static Complex multiply(Complex x, Complex y) {
    Complex result = {x.re * y.re - x.im * y.im, x.re * y.im + x.im * y.re};
    return result;
}
static double magnitude(Complex value) {
    return sqrt(value.re * value.re + value.im * value.im);
}
static double gain_db(Complex value) {
    double amplitude = magnitude(value);
    if (!(amplitude > 0) || !isfinite(amplitude)) fail("invalid frequency response");
    return 20 * log10(amplitude);
}
static Complex response(const Section *section, double frequency, double fs) {
    double w = 2 * PI * frequency / fs;
    double c1 = cos(w), s1 = -sin(w), c2 = cos(2 * w), s2 = -sin(2 * w);
    double nr = section->b[0] + section->b[1] * c1 + section->b[2] * c2;
    double ni = section->b[1] * s1 + section->b[2] * s2;
    double dr = 1 + section->a[1] * c1 + section->a[2] * c2;
    double di = section->a[1] * s1 + section->a[2] * s2;
    double denominator = dr * dr + di * di;
    Complex result;
    if (!(denominator > 0) || !isfinite(denominator)) fail("singular frequency response");
    result.re = (nr * dr + ni * di) / denominator;
    result.im = (ni * dr - nr * di) / denominator;
    return result;
}
static void design(Section *s, double fs) {
    double w, alpha, amplitude, a0, theta, phi, discriminant, root;
    int i;
    if (!(s->center > 0 && s->center < fs / 2 && s->width > 0 && s->width < fs / 2 &&
          s->requested_q > 0 && s->gain < 0)) fail("center, bandwidth, Q or attenuation outside valid range");
    w = 2 * PI * s->center / fs;
    alpha = tan(PI * s->width / fs);
    s->q = sin(w) / (2 * alpha);
    if (!isfinite(s->q) || fabs(s->requested_q - s->q) > 1e-7) fail("Q does not match half-gain bandwidth");
    amplitude = pow(10, s->gain / 40);
    if (!(amplitude > 0) || !isfinite(amplitude)) fail("attenuation is not representable");
    a0 = 1 + alpha / amplitude;
    s->b[0] = (1 + alpha * amplitude) / a0;
    s->b[1] = -2 * cos(w) / a0;
    s->b[2] = (1 - alpha * amplitude) / a0;
    s->a[0] = 1;
    s->a[1] = s->b[1];
    s->a[2] = (1 - alpha / amplitude) / a0;
    for (i = 0; i < 3; ++i)
        if (!isfinite(s->a[i]) || !isfinite(s->b[i])) fail("non-finite coefficient");
    discriminant = s->a[1] * s->a[1] - 4 * s->a[2];
    if (discriminant < 0) {
        root = sqrt(-discriminant) / 2;
        s->poles[0].re = s->poles[1].re = -s->a[1] / 2;
        s->poles[0].im = root; s->poles[1].im = -root;
    } else {
        root = sqrt(discriminant);
        s->poles[0].re = (-s->a[1] + root) / 2;
        s->poles[1].re = (-s->a[1] - root) / 2;
        s->poles[0].im = s->poles[1].im = 0;
    }
    for (i = 0; i < 2; ++i)
        if (!(magnitude(s->poles[i]) < 1)) fail("unstable section");
    /* Half-gain crossings satisfy |cos(w)-cos(w0)| = alpha*sin(w).
     * Their digital midpoint need not equal w0 in Hz. */
    theta = acos(cos(w) / sqrt(1 + alpha * alpha));
    phi = atan(alpha);
    s->edges[0] = (theta - phi) * fs / (2 * PI);
    s->edges[1] = (theta + phi) * fs / (2 * PI);
    if (!(s->edges[0] > 0 && s->edges[1] < fs / 2) ||
        fabs(s->edges[1] - s->edges[0] - s->width) > .001) fail("invalid half-gain bandwidth");
    if (fabs(gain_db(response(s, s->center, fs)) - s->gain) > 1e-6 ||
        fabs(gain_db(response(s, 0, fs))) > 1e-6 ||
        fabs(gain_db(response(s, fs / 2, fs))) > 1e-6) fail("center or endpoint response check failed");
    for (i = 0; i < 2; ++i)
        if (fabs(gain_db(response(s, s->edges[i], fs)) - s->gain / 2) > 1e-6)
            fail("half-gain response check failed");
}
static FILE *new_response_file(const char *path) {
    int descriptor;
    FILE *file;
#ifdef _WIN32
    descriptor = _open(path, _O_WRONLY | _O_CREAT | _O_EXCL | _O_BINARY, _S_IREAD | _S_IWRITE);
    if (descriptor < 0) fail("cannot exclusively create response CSV");
    file = _fdopen(descriptor, "wb");
    if (!file) { _close(descriptor); fail("cannot open response stream"); }
#else
    descriptor = open(path, O_WRONLY | O_CREAT | O_EXCL, 0644);
    if (descriptor < 0) fail("cannot exclusively create response CSV");
    file = fdopen(descriptor, "w");
    if (!file) { close(descriptor); fail("cannot open response stream"); }
#endif
    return file;
}
static int frequency_order(const void *left, const void *right) {
    double a = *(const double *)left, b = *(const double *)right;
    return (a > b) - (a < b);
}
static void write_value(FILE *file, Complex value) {
    double db = gain_db(value), phase = atan2(value.im, value.re) * 180 / PI;
    if (!isfinite(phase) || db > 1e-9) fail("invalid cut-filter response");
    fprintf(file, ",%.17g,%.17g,%.17g,%.17g", value.re, value.im, db, phase);
}
int main(int argc, char **argv) {
    Section sections[2];
    double fs = 0, frequencies[GRID_COUNT];
    const char *csv_path = NULL;
    int i, j, count = 0, samples = 0;
    FILE *csv;
    memset(sections, 0, sizeof(sections));
    for (i = 1; i < argc; ++i) {
        if (!strcmp(argv[i], "--sample-rate") && i + 1 < argc && !fs) fs = number(argv[++i]);
        else if (!strcmp(argv[i], "--section") && i + 4 < argc && count < 2) {
            Section *s = &sections[count++];
            s->center = number(argv[++i]); s->width = number(argv[++i]);
            s->requested_q = number(argv[++i]); s->gain = number(argv[++i]);
        } else if (!strcmp(argv[i], "--response") && i + 1 < argc && !csv_path) csv_path = argv[++i];
        else fail("usage: --sample-rate 16000 --section CENTER BW Q GAIN (twice) --response NEW.csv");
    }
    if (fs != 16000 || count != 2 || !csv_path || sections[0].center == sections[1].center)
        fail("expected two distinct sections at 16kHz");
    for (i = 0; i < 2; ++i) design(&sections[i], fs);
    for (i = 0; i <= 16000; ++i) frequencies[samples++] = i * GRID_STEP;
    for (i = 0; i < 2; ++i) {
        frequencies[samples++] = sections[i].center;
        frequencies[samples++] = sections[i].edges[0];
        frequencies[samples++] = sections[i].edges[1];
    }
    qsort(frequencies, samples, sizeof(double), frequency_order);
    /* Exact centers can already lie on the regular grid (e.g. 5062.5 Hz). */
    count = 0;
    for (i = 0; i < samples; ++i)
        if (!count || frequencies[i] != frequencies[count - 1]) frequencies[count++] = frequencies[i];
    samples = count;
    csv = new_response_file(csv_path);
    fprintf(csv, "frequency_hz,eq1_real,eq1_imag,eq1_gain_db,eq1_phase_deg,eq2_real,eq2_imag,eq2_gain_db,eq2_phase_deg,cascade_real,cascade_imag,cascade_gain_db,cascade_phase_deg\n");
    for (i = 0; i < samples; ++i) {
        Complex first = response(&sections[0], frequencies[i], fs);
        Complex second = response(&sections[1], frequencies[i], fs);
        Complex cascade = multiply(first, second);
        fprintf(csv, "%.17g", frequencies[i]);
        write_value(csv, first); write_value(csv, second); write_value(csv, cascade);
        fputc('\n', csv);
    }
    if (ferror(csv)) fail("cannot write response CSV");
    if (fclose(csv)) fail("cannot close response CSV");
    printf("{\"tool_version\":\"%s\",\"sample_rate_hz\":%.17g,\"coefficient_convention\":\"a0=1; y=b0*x+b1*x1+b2*x2-a1*y1-a2*y2\",\"response_step_hz\":%.17g,\"response_rows\":%d,\"sections\":[", TOOL, fs, GRID_STEP, samples);
    for (i = 0; i < 2; ++i) {
        Section *s = &sections[i];
        if (i) putchar(',');
        printf("{\"id\":\"eq%d\",\"order\":2,\"center_hz\":%.17g,\"bandwidth_hz\":%.17g,\"q\":%.17g,\"gain_db\":%.17g,\"b\":[%.17g,%.17g,%.17g],\"a\":[%.17g,%.17g,%.17g],\"half_gain_edges_hz\":[%.17g,%.17g],\"poles\":[", i + 1, s->center, s->width, s->q, s->gain, s->b[0], s->b[1], s->b[2], s->a[0], s->a[1], s->a[2], s->edges[0], s->edges[1]);
        for (j = 0; j < 2; ++j) {
            if (j) putchar(',');
            printf("{\"real\":%.17g,\"imag\":%.17g,\"radius\":%.17g}", s->poles[j].re, s->poles[j].im, magnitude(s->poles[j]));
        }
        printf("],\"checks\":{\"center_gain_db\":%.17g,\"low_edge_gain_db\":%.17g,\"high_edge_gain_db\":%.17g,\"dc_gain_db\":%.17g,\"nyquist_gain_db\":%.17g}}", gain_db(response(s, s->center, fs)), gain_db(response(s, s->edges[0], fs)), gain_db(response(s, s->edges[1], fs)), gain_db(response(s, 0, fs)), gain_db(response(s, fs / 2, fs)));
    }
    printf("],\"cascade_center_gain_db\":[");
    for (i = 0; i < 2; ++i) {
        Complex first = response(&sections[0], sections[i].center, fs);
        Complex second = response(&sections[1], sections[i].center, fs);
        if (i) putchar(',');
        printf("%.17g", gain_db(multiply(first, second)));
    }
    printf("],\"verification\":{\"status\":\"passed\",\"gain_tolerance_db\":1e-6,\"bandwidth_tolerance_hz\":0.001,\"stable\":true}}\n");
    if (ferror(stdout)) fail("cannot write design JSON");
    return EXIT_SUCCESS;
}
