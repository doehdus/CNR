/* Butterworth 2: -3 dB cutoffs 109..6000 Hz, fs=16000 Hz.
 * Lowpass prototype order 16; digital bandpass order 32; 16 SOS.
 * Coefficients frozen with scipy.signal.butter(..., output="sos").
 * C performs causal DF2-transposed filtering, reset for each WAV, fixed output gain -1.7 dB.
 * No clipping, normalization, padding, resampling, fades or noise estimation.
 */
static const double OUTPUT_GAIN = 0.82224264994707119;
#define FILTER_ID "bpf02"
#define LOWER_HZ 109
#define UPPER_HZ 6000
#define PROTOTYPE_ORDER 16
#define SECTION_COUNT 16
static const double SOS[SECTION_COUNT][6] = {
    {0.012364822968850877, 0.024729645937701755, 0.012364822968850877, 1, 0.81526478556028559, 0.16790615410927795},
    {1, 2, 1, 1, 0.83017478498648367, 0.18803070699512997},
    {1, 2, 1, 1, 0.86052858070940397, 0.2291457621806729},
    {1, 2, 1, 1, 0.90750591532919256, 0.2931283932758581},
    {1, 2, 1, 1, 0.97315522471890636, 0.38316276338766941},
    {1, 2, 1, 1, 1.0607346164120264, 0.50420834024176742},
    {1, 2, 1, 1, 1.1751989947805388, 0.66368813757183631},
    {1, 2, 1, 1, 1.3238804747177553, 0.87246758054515683},
    {1, -2, 1, 1, -1.9150926398637071, 0.9169123237577339},
    {1, -2, 1, 1, -1.9183751962857771, 0.92019284037038529},
    {1, -2, 1, 1, -1.9247673115406652, 0.92658160113086752},
    {1, -2, 1, 1, -1.933954292799458, 0.93576517718471719},
    {1, -2, 1, 1, -1.945528198554054, 0.94733713831149102},
    {1, -2, 1, 1, -1.959034597352201, 0.96084451842104346},
    {1, -2, 1, 1, -1.9740042103339541, 0.97581922965200651},
    {1, -2, 1, 1, -1.9899650696633933, 0.9917900696285068},
};
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <io.h>

typedef struct { double b[3], a[2], z[2]; } Section;
static void fail(const char *message) { fprintf(stderr, "Prefilter failed: %s\n", message); exit(1); }
static unsigned u16(const unsigned char *p) { return p[0] | ((unsigned)p[1] << 8); }
static uint32_t u32(const unsigned char *p) { return u16(p) | ((uint32_t)u16(p + 2) << 16); }
static void exact(FILE *file, unsigned char *p, size_t n) { if (fread(p, 1, n, file) != n) fail("truncated WAV"); }
static void put16(FILE *f, unsigned value) { fputc(value & 255, f); fputc((value >> 8) & 255, f); }
static void put32(FILE *f, uint32_t value) { put16(f, value & 65535); put16(f, value >> 16); }
int main(int argc, char **argv) {
    const char *input = NULL, *output = NULL;
    Section sections[SECTION_COUNT];
    unsigned char header[16];
    FILE *file;
    long length, boundary, offset = -1;
    uint32_t bytes = 0, count, index;
    int format = 0, section_count = SECTION_COUNT, i, j, descriptor, measure_only = 0;
    uint32_t overflow_count = 0;
    int16_t *samples;
    double input_peak = 0, output_peak = 0;
    memset(sections, 0, sizeof(sections));
    for (i = 0; i < SECTION_COUNT; ++i) {
        for (j = 0; j < 3; ++j) sections[i].b[j] = SOS[i][j];
        for (j = 0; j < 2; ++j) sections[i].a[j] = SOS[i][j + 4];
    }
    for (i = 1; i < argc; ++i) {
        if (!strcmp(argv[i], "--input") && i + 1 < argc && !input) input = argv[++i];
        else if (!strcmp(argv[i], "--measure-only") && !measure_only) measure_only = 1;
        else if (!strcmp(argv[i], "--output") && i + 1 < argc && !output) output = argv[++i];
        else fail("expected --input WAV --output NEW.wav, or --input WAV --measure-only; coefficients are fixed");
    }
    if (!input || (!measure_only && !output) || (measure_only && output) || (output && !strcmp(input, output))) fail("separate input/output, or measure-only without output, are required");
    file = fopen(input, "rb");
    if (!file) fail("cannot open input");
    if (fseek(file, 0, SEEK_END) || (length = ftell(file)) < 12) fail("invalid WAV length");
    rewind(file); exact(file, header, 12);
    if (memcmp(header, "RIFF", 4) || memcmp(header + 8, "WAVE", 4) || (uint64_t)u32(header + 4) + 8 != (uint64_t)length) fail("invalid RIFF boundary");
    boundary = length;
    while (ftell(file) <= boundary - 8) {
        uint32_t size; uint64_t next;
        exact(file, header, 8); size = u32(header + 4);
        next = (uint64_t)ftell(file) + size + (size & 1);
        if (next > (uint64_t)boundary) fail("chunk outside RIFF boundary");
        if (!memcmp(header, "fmt ", 4)) {
            if (format || size < 16) fail("invalid format chunk");
            exact(file, header, 16);
            if (u16(header) != 1 || u16(header + 2) != 1 || u32(header + 4) != 16000 || u32(header + 8) != 32000 || u16(header + 12) != 2 || u16(header + 14) != 16) fail("expected 16kHz mono PCM16");
            format = 1;
        } else if (!memcmp(header, "data", 4)) {
            if (offset >= 0) fail("multiple data chunks");
            offset = ftell(file); bytes = size;
        }
        if (fseek(file, (long)next, SEEK_SET)) fail("cannot seek WAV chunk");
    }
    if (!format || offset < 0 || !bytes || bytes % 2 || bytes > UINT32_MAX - 36) fail("missing PCM data");
    count = bytes / 2; samples = malloc(bytes);
    if (!samples) fail("cannot allocate samples");
    if (fseek(file, offset, SEEK_SET)) fail("cannot seek PCM data");
    for (index = 0; index < count; ++index) {
        int value; double x, y, rounded;
        exact(file, header, 2); value = (int)u16(header); if (value >= 32768) value -= 65536;
        x = value / 32768.0;
        if (fabs(x) > input_peak) input_peak = fabs(x);
        for (j = 0; j < section_count; ++j) {
            Section *s = &sections[j];
            y = s->b[0] * x + s->z[0];
            s->z[0] = s->b[1] * x - s->a[0] * y + s->z[1];
            s->z[1] = s->b[2] * x - s->a[1] * y;
            x = y;
        }
        if (!isfinite(x)) fail("non-finite filtered sample");
        x *= OUTPUT_GAIN;
        if (fabs(x) > output_peak) output_peak = fabs(x);
        y = x * 32768;
        rounded = y >= 0 ? floor(y + .5) : ceil(y - .5);
        if (rounded < -32768 || rounded > 32767) { overflow_count++; if (!measure_only) fail("PCM16 overflow; no clipping or automatic gain applied"); }
        samples[index] = measure_only ? 0 : (int16_t)rounded;
    }
    if (fclose(file)) fail("cannot close input");
    if (measure_only) {
        free(samples);
        printf("{\"tool_version\":\"cnr-prefilter-headroom/1\",\"sample_count\":%lu,\"input_peak\":%.17g,\"output_peak\":%.17g,\"would_overflow_samples\":%lu}\n",(unsigned long)count,input_peak,output_peak,(unsigned long)overflow_count);
        return 0;
    }
    descriptor = _open(output, _O_WRONLY | _O_CREAT | _O_EXCL | _O_BINARY, _S_IREAD | _S_IWRITE);
    if (descriptor < 0) fail("cannot exclusively create output WAV");
    file = _fdopen(descriptor, "wb"); if (!file) { _close(descriptor); fail("cannot open output stream"); }
    fwrite("RIFF", 1, 4, file); put32(file, bytes + 36); fwrite("WAVEfmt ", 1, 8, file);
    put32(file, 16); put16(file, 1); put16(file, 1); put32(file, 16000); put32(file, 32000); put16(file, 2); put16(file, 16);
    fwrite("data", 1, 4, file); put32(file, bytes);
    for (index = 0; index < count; ++index) put16(file, (uint16_t)samples[index]);
    free(samples);
    if (ferror(file)) fail("cannot write output WAV");
    if (fclose(file)) fail("cannot close output WAV");
    printf("{\"output_gain_db\":-1.7,\"filter_id\":\"%s\",\"lower_hz\":%d,\"upper_hz\":%d,\"prototype_order\":%d,\"sos_sections\":%d,\"tool_version\":\"cnr-fixed-prefilter/2\",\"sample_rate_hz\":16000,\"sample_count\":%lu,\"input_peak\":%.17g,\"output_peak\":%.17g,\"clipped_samples\":0}\n", FILTER_ID, LOWER_HZ, UPPER_HZ, PROTOTYPE_ORDER, SECTION_COUNT, (unsigned long)count, input_peak, output_peak);
    return 0;
}
