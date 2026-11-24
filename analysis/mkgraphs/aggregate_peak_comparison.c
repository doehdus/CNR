/* Aggregate completed trajectory statistics and integrate completed mean PSD.
 * No WAV loading, FFT, PSD averaging or peak detection is performed here. */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

#define BINS 1025
#define MEMBERS 12
static void fail(const char *message) { fprintf(stderr, "%s\n", message); exit(1); }
static void scalar(FILE *file, double value, int valid) {
    if (valid) fprintf(file, "%.12g", value); else fputs("null", file);
}
int main(int argc, char **argv) {
    FILE *input, *output, *existing;
    double frequency[BINS], clean[BINS], noise[BINS];
    if (argc != 3) fail("Expected completed numeric input and a new JSON output path.");
    input = fopen(argv[1], "rb"); if (!input) fail("Cannot read completed measurements.");
    existing = fopen(argv[2], "rb"); if (existing) { fclose(existing); fail("Output exists."); }
    output = fopen(argv[2], "wb"); if (!output) fail("Cannot create aggregate output.");
    fputs("{\"version\":1,\"groups\":[", output);
    for (int g = 0; g < 20; ++g) {
        int group, peaks;
        if (fscanf(input, "%d%d", &group, &peaks) != 2 || group != g || peaks < 0 || peaks > 8) fail("Invalid group.");
        for (int b = 0; b < BINS; ++b) {
            double c, n;
            if (fscanf(input, "%lf%lf%lf", &frequency[b], &c, &n) != 3 || frequency[b] != b * 16000.0 / 2048 || !isfinite(c) || !isfinite(n)) fail("Invalid completed PSD.");
            clean[b] = pow(10, c / 10); noise[b] = pow(10, n / 10);
        }
        fprintf(output, "%s{\"peaks\":[", g ? "," : "");
        for (int p = 0; p < peaks; ++p) {
            int id, mixture_count, clean_count, noise_count, reference_valid, valid_count = 0;
            int detected_mixture = 0, detected_clean = 0, detected_noise = 0;
            double center, low, high, width, reference_mean, reference_std, reference_appearance;
            double frequency_sum = 0, std_sum = 0, appearance_sum = 0, clean_power = 0, noise_power = 0;
            if (fscanf(input, "%d%lf%lf%lf%lf%d%d%d%d%lf%lf%lf", &id, &center, &low, &high, &width,
                    &mixture_count, &clean_count, &noise_count, &reference_valid, &reference_mean, &reference_std, &reference_appearance) != 12 || id != p + 1 ||
                    !isfinite(center) || !isfinite(low) || !isfinite(high) || !isfinite(width) || low < 0 || high > 8000 || low >= high ||
                    center < low || center > high || width <= 0 || mixture_count < -1 || mixture_count > MEMBERS || clean_count < -1 || clean_count > MEMBERS ||
                    noise_count < -1 || noise_count > MEMBERS || reference_valid < 0 || reference_valid > 1 ||
                    !isfinite(reference_mean) || !isfinite(reference_std) || !isfinite(reference_appearance) || reference_std < 0 || reference_appearance < 0 || reference_appearance > 100) fail("Invalid source peak.");
            for (int m = 0; m < MEMBERS; ++m) {
                int valid, dm, dc, dn; double mean, std, appearance;
                if (fscanf(input, "%d%lf%lf%lf%d%d%d", &valid, &mean, &std, &appearance, &dm, &dc, &dn) != 7 || valid < 0 || valid > 1 ||
                        !isfinite(mean) || !isfinite(std) || !isfinite(appearance) || std < 0 || appearance < 0 || appearance > 100 ||
                        (!valid && (mean != 0 || std != 0 || appearance != 0))) fail("Invalid completed trajectory.");
                if (dm < -1 || dm > 1 || dc < -1 || dc > 1 || dn < -1 || dn > 1 ||
                    (mixture_count < 0 && dm < 0) || (clean_count < 0 && dc < 0) || (noise_count < 0 && dn < 0)) fail("Invalid detection flag.");
                detected_mixture += dm > 0; detected_clean += dc > 0; detected_noise += dn > 0;
                if (valid) { ++valid_count; frequency_sum += mean; std_sum += std; appearance_sum += appearance; }
            }
            if (mixture_count < 0) mixture_count = detected_mixture;
            if (clean_count < 0) clean_count = detected_clean;
            if (noise_count < 0) noise_count = detected_noise;
            for (int b = 0; b < BINS; ++b) if (frequency[b] >= low && frequency[b] <= high) {
                clean_power += clean[b]; noise_power += noise[b];
            }
            if (!(clean_power > 0) || !(noise_power > 0)) fail("Empty comparison band.");
            fprintf(output, "%s{\"peak_id\":\"p%d\",\"frequency_hz\":%.12g,\"low_hz\":%.12g,\"high_hz\":%.12g,\"width_hz\":%.12g,"
                "\"mixture_count\":%d,\"clean_count\":%d,\"added_noise_count\":%d,\"valid_tracks\":%d,\"mean_std_hz\":",
                p ? "," : "", id, center, low, high, width, mixture_count, clean_count, noise_count, valid_count);
            scalar(output, valid_count ? std_sum / valid_count : 0, valid_count);
            fputs(",\"mean_frequency_hz\":", output); scalar(output, valid_count ? frequency_sum / valid_count : 0, valid_count);
            fputs(",\"mean_offset_hz\":", output); scalar(output, valid_count ? frequency_sum / valid_count - center : 0, valid_count);
            fprintf(output, ",\"mean_appearance_percent\":%.12g,\"clean_to_noise_db\":%.12g,\"noise_reference_std_hz\":",
                appearance_sum / MEMBERS, 10 * log10(clean_power / noise_power));
            scalar(output, reference_std, reference_valid);
            fputs(",\"noise_reference_mean_hz\":", output); scalar(output, reference_mean, reference_valid);
            fputs(",\"noise_reference_offset_hz\":", output); scalar(output, reference_mean - center, reference_valid);
            fputs(",\"noise_reference_appearance_percent\":", output); scalar(output, reference_appearance, reference_valid);
            fputc('}', output);
        }
        fputs("]}", output);
    }
    { char extra; if (fscanf(input, " %c", &extra) != EOF) fail("Unexpected trailing measurements."); }
    fclose(input); fputs("]}\n", output);
    if (ferror(output) || fclose(output)) fail("Cannot finish aggregate output.");
    return 0;
}
