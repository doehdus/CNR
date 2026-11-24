/* Whole-record FFT for mono PCM16 RIFF/WAVE files. */
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PI 3.14159265358979323846264338327950288
#define AMPLITUDE_FLOOR 1e-15

typedef struct {
    unsigned long sample_rate;
    size_t sample_count;
    size_t fft_size;
    double window_sum;
    double window_energy;
    double *real;
    double *imaginary;
} Spectrum;

static void fail(const char *message) {
    fprintf(stderr, "Noise FFT failed: %s\n", message);
    exit(EXIT_FAILURE);
}

static uint16_t little_u16(const unsigned char *bytes) {
    return (uint16_t)(bytes[0] | ((uint16_t)bytes[1] << 8));
}

static uint32_t little_u32(const unsigned char *bytes) {
    return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8)
         | ((uint32_t)bytes[2] << 16) | ((uint32_t)bytes[3] << 24);
}

static void read_exact(FILE *file, unsigned char *bytes, size_t count) {
    if (fread(bytes, 1, count, file) != count) fail("truncated WAV file");
}

static Spectrum read_wave(const char *path, const char *window_function) {
    FILE *file = fopen(path, "rb");
    unsigned char header[16];
    long file_size, riff_end, data_offset = -1;
    uint32_t data_size = 0, sample_rate = 0;
    int found_format = 0;
    Spectrum result;
    size_t index;

    if (!file) fail("cannot open input WAV");
    if (fseek(file, 0, SEEK_END) != 0 || (file_size = ftell(file)) < 12) {
        fail("WAV file is too short or too large");
    }
    rewind(file);
    read_exact(file, header, 12);
    if (memcmp(header, "RIFF", 4) || memcmp(header + 8, "WAVE", 4)) {
        fail("expected little-endian RIFF/WAVE");
    }
    if ((uint64_t)little_u32(header + 4) + 8 > (uint64_t)file_size) {
        fail("declared RIFF length exceeds file size");
    }
    riff_end = (long)((uint64_t)little_u32(header + 4) + 8);

    while (ftell(file) <= riff_end - 8) {
        uint32_t chunk_size;
        long payload_offset, next_offset;
        uint64_t next_position;
        read_exact(file, header, 8);
        chunk_size = little_u32(header + 4);
        payload_offset = ftell(file);
        next_position = (uint64_t)payload_offset + chunk_size + (chunk_size & 1);
        if (next_position > (uint64_t)riff_end || next_position > LONG_MAX) {
            fail("WAV chunk exceeds RIFF boundary");
        }
        next_offset = (long)next_position;
        if (!memcmp(header, "fmt ", 4)) {
            if (found_format || chunk_size < 16) fail("invalid format chunk");
            read_exact(file, header, 16);
            sample_rate = little_u32(header + 4);
            if (little_u16(header) != 1 || little_u16(header + 2) != 1
                    || little_u16(header + 14) != 16 || little_u16(header + 12) != 2
                    || !sample_rate || sample_rate > UINT32_MAX / 2
                    || little_u32(header + 8) != sample_rate * 2) {
                fail("supported input is mono PCM16 WAV");
            }
            found_format = 1;
        } else if (!memcmp(header, "data", 4)) {
            if (data_offset >= 0) fail("multiple data chunks are unsupported");
            data_offset = payload_offset;
            data_size = chunk_size;
        }
        if (fseek(file, next_offset, SEEK_SET) != 0) fail("cannot seek WAV chunk");
    }
    if (!found_format || data_offset < 0 || data_size < 4 || data_size % 2) {
        fail("missing format/data or incomplete PCM16 samples");
    }

    memset(&result, 0, sizeof(result));
    result.sample_rate = sample_rate;
    result.sample_count = data_size / 2;
    result.fft_size = 1;
    while (result.fft_size < result.sample_count) {
        if (result.fft_size > SIZE_MAX / 2) fail("FFT size overflow");
        result.fft_size *= 2;
    }
    if (result.fft_size > SIZE_MAX / sizeof(double)) fail("FFT allocation overflow");
    result.real = calloc(result.fft_size, sizeof(double));
    result.imaginary = calloc(result.fft_size, sizeof(double));
    if (!result.real || !result.imaginary) fail("cannot allocate FFT buffers");

    if (fseek(file, data_offset, SEEK_SET) != 0) fail("cannot seek PCM data");
    for (index = 0; index < result.sample_count; ++index) {
        unsigned char bytes[2];
        int sample;
        double weight = 1.0;
        read_exact(file, bytes, 2);
        sample = little_u16(bytes);
        if (sample >= 32768) sample -= 65536;
        if (!strcmp(window_function, "hann_periodic")) {
            weight = 0.5 - 0.5 * cos(2.0 * PI * (double)index / result.sample_count);
        }
        result.real[index] = (sample / 32768.0) * weight;
        result.window_sum += weight;
        result.window_energy += weight * weight;
    }
    if (fclose(file) != 0) fail("cannot close input WAV");
    return result;
}

static void transform(Spectrum *spectrum) {
    size_t index, reversed = 0, width;
    size_t count = spectrum->fft_size;
    double *real = spectrum->real;
    double *imaginary = spectrum->imaginary;

    for (index = 1; index < count; ++index) {
        size_t bit = count >> 1;
        while (reversed & bit) {
            reversed ^= bit;
            bit >>= 1;
        }
        reversed ^= bit;
        if (index < reversed) {
            double temporary = real[index];
            real[index] = real[reversed];
            real[reversed] = temporary;
            temporary = imaginary[index];
            imaginary[index] = imaginary[reversed];
            imaginary[reversed] = temporary;
        }
    }
    for (width = 2; width <= count; width *= 2) {
        size_t start, offset, half = width / 2;
        double angle = -2.0 * PI / width;
        double step_real = cos(angle), step_imaginary = sin(angle);
        for (start = 0; start < count; start += width) {
            double rotation_real = 1.0, rotation_imaginary = 0.0;
            for (offset = 0; offset < half; ++offset) {
                size_t even = start + offset, odd = even + half;
                double odd_real = rotation_real * real[odd] - rotation_imaginary * imaginary[odd];
                double odd_imaginary = rotation_real * imaginary[odd] + rotation_imaginary * real[odd];
                double next_rotation = rotation_real * step_real - rotation_imaginary * step_imaginary;
                real[odd] = real[even] - odd_real;
                imaginary[odd] = imaginary[even] - odd_imaginary;
                real[even] += odd_real;
                imaginary[even] += odd_imaginary;
                rotation_imaginary = rotation_real * step_imaginary + rotation_imaginary * step_real;
                rotation_real = next_rotation;
            }
        }
        if (width == count) break;
    }
}

static FILE *create_output(const char *path) {
    FILE *existing = fopen(path, "rb");
    FILE *result;
    if (existing) {
        fclose(existing);
        fail("output exists; use a new output path");
    }
    result = fopen(path, "wb");
    if (!result) fail("cannot create output file");
    return result;
}

static void write_spectrum(const char *path, const Spectrum *spectrum) {
    FILE *file = create_output(path);
    size_t bin;
    fprintf(file, "frequency_hz,amplitude,magnitude_dbfs,power_density_fs2_hz\n");
    for (bin = 0; bin <= spectrum->fft_size / 2; ++bin) {
        double real = spectrum->real[bin], imaginary = spectrum->imaginary[bin];
        double squared = real * real + imaginary * imaginary;
        double factor = (bin == 0 || bin == spectrum->fft_size / 2) ? 1.0 : 2.0;
        double amplitude = factor * sqrt(squared) / spectrum->window_sum;
        double density = factor * squared / (spectrum->sample_rate * spectrum->window_energy);
        double finite_amplitude = amplitude < AMPLITUDE_FLOOR ? AMPLITUDE_FLOOR : amplitude;
        double frequency = (double)bin * spectrum->sample_rate / spectrum->fft_size;
        fprintf(file, "%.17g,%.17g,%.17g,%.17g\n", frequency, amplitude,
                20.0 * log10(finite_amplitude), density);
    }
    if (ferror(file) || fclose(file) != 0) fail("cannot write spectrum CSV");
}

static void write_metadata(const char *path, const Spectrum *spectrum, const char *window_function) {
    FILE *file = create_output(path);
    fprintf(file,
        "{\n"
        "  \"version\": 1,\n"
        "  \"tool_version\": \"cnr-noise-fft/1\",\n"
        "  \"method\": \"full_fft\",\n"
        "  \"sample_rate_hz\": %lu,\n"
        "  \"sample_count\": %lu,\n"
        "  \"fft_size\": %lu,\n"
        "  \"duration_seconds\": %.17g,\n"
        "  \"fft_bin_hz\": %.17g,\n"
        "  \"record_bin_hz\": %.17g,\n"
        "  \"window_function\": \"%s\",\n"
        "  \"window_sum\": %.17g,\n"
        "  \"window_energy\": %.17g,\n"
        "  \"magnitude_reference\": \"One-sided peak amplitude / PCM full scale 1.0; coherent-gain corrected, dBFS\",\n"
        "  \"numeric_floor_dbfs\": -300\n"
        "}\n",
        spectrum->sample_rate, (unsigned long)spectrum->sample_count,
        (unsigned long)spectrum->fft_size,
        (double)spectrum->sample_count / spectrum->sample_rate,
        (double)spectrum->sample_rate / spectrum->fft_size,
        (double)spectrum->sample_rate / spectrum->sample_count,
        window_function, spectrum->window_sum, spectrum->window_energy);
    if (ferror(file) || fclose(file) != 0) fail("cannot write metadata JSON");
}

int main(int argc, char **argv) {
    const char *input = NULL, *csv = NULL, *metadata = NULL, *window_function = NULL;
    Spectrum spectrum;
    int index;
    if (argc != 9) {
        fprintf(stderr, "Usage: noise_fft --input WAV --spectrum CSV --metadata JSON --window hann_periodic|rectangular\n");
        return EXIT_FAILURE;
    }
    for (index = 1; index < argc; index += 2) {
        const char **destination = NULL;
        if (!strcmp(argv[index], "--input")) destination = &input;
        else if (!strcmp(argv[index], "--spectrum")) destination = &csv;
        else if (!strcmp(argv[index], "--metadata")) destination = &metadata;
        else if (!strcmp(argv[index], "--window")) destination = &window_function;
        if (!destination || *destination) fail("unknown or repeated argument");
        *destination = argv[index + 1];
    }
    if (!input || !csv || !metadata || !window_function) fail("missing argument");
    if (strcmp(window_function, "hann_periodic") && strcmp(window_function, "rectangular")) {
        fail("unsupported window function");
    }
    spectrum = read_wave(input, window_function);
    transform(&spectrum);
    write_spectrum(csv, &spectrum);
    write_metadata(metadata, &spectrum, window_function);
    free(spectrum.real);
    free(spectrum.imaginary);
    return EXIT_SUCCESS;
}
