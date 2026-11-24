/* Cohort summaries reuse the individual analyzer's FFT, PSD and peak rules.
 * Included after its numerical functions; never writes normalized audio. */
#define SUMMARY_LIMIT 12
typedef struct {
    char id[64], mixture[2048], reference[2048];
    size_t begin, end, samples;
    double rms, gain, snr;
} SummaryMember;

static int summary_match(const Peaks *peaks, double frequency, double width) {
    double tolerance = MAXIMUM(minimum_match_bins * FS / FFT_SIZE, width * match_width_fraction);
    return nearest(peaks, frequency, tolerance) != NULL;
}
static void summary_nullable(FILE *file, double value, int present) {
    if (present) fprintf(file, "%.12g", value); else fputs("null", file);
}
static void summarize_mixtures(const char *manifest, const char *anchor_path, const char *output, size_t split) {
    SummaryMember *members = allocate(SUMMARY_LIMIT, sizeof(SummaryMember));
    Analysis *values = allocate(SUMMARY_LIMIT * 3, sizeof(Analysis));
    Anchor anchors[TOP_PEAKS];
    int count = 0, anchor_count = 0, read;
    size_t max_frames = 0;
    char line[8192];
    double *segments = allocate(2 * 3 * BINS, sizeof(double));
    FILE *input = fopen(manifest, "rb"), *file;
    if (!input) fail("cannot read summary manifest");
    while (fgets(line, sizeof(line), input)) {
        unsigned long begin, end;
        SummaryMember *member;
        if (count == SUMMARY_LIMIT) fail("too many summary members");
        member = &members[count];
        if (sscanf(line, "%lu\t%lu\t%63[^\t]\t%2047[^\t]\t%2047[^\r\n]", &begin, &end,
                   member->id, member->mixture, member->reference) != 5) fail("malformed summary manifest");
        for (int i = 0; i < count; ++i) if (!strcmp(member->id, members[i].id)) fail("duplicate summary member");
        for (size_t i = 0; member->id[i]; ++i)
            if (!((member->id[i] >= 'a' && member->id[i] <= 'z') || (member->id[i] >= '0' && member->id[i] <= '9')))
                fail("invalid summary member identifier");
        member->begin = begin; member->end = end; ++count;
    }
    if (ferror(input) || fclose(input) || !count) fail("empty or unreadable summary manifest");
    input = fopen(anchor_path, "rb");
    if (!input) fail("cannot read summary anchors");
    while ((read = fscanf(input, "%d,%lf,%lf,%lf,%lf", &anchors[anchor_count].id, &anchors[anchor_count].frequency,
            &anchors[anchor_count].width, &anchors[anchor_count].low, &anchors[anchor_count].high)) == 5) {
        Anchor *a = &anchors[anchor_count];
        if (a->id != anchor_count + 1 || !isfinite(a->frequency) || !isfinite(a->width) || !isfinite(a->low) ||
            !isfinite(a->high) || a->width <= 0 || a->low < 0 || a->high > FS / 2 || a->low >= a->high ||
            a->frequency < a->low || a->frequency > a->high) fail("invalid summary anchor");
        if (++anchor_count == TOP_PEAKS) break;
    }
    if (anchor_count < TOP_PEAKS && read != EOF) fail("malformed summary anchors");
    fclose(input);
    for (int m = 0; m < count; ++m) {
        SummaryMember *member = &members[m];
        Wave mixture = read_wave(member->mixture), speech = read_wave(member->reference);
        double energy = 0, noise_energy = 0, *added;
        if (mixture.count != speech.count || member->begin >= member->end || member->end > mixture.count)
            fail("invalid summary reference or interval");
        if (split && (split < FFT_SIZE || mixture.count < split + FFT_SIZE)) fail("summary split too short");
        member->samples = mixture.count;
        for (size_t i = member->begin; i < member->end; ++i) {
            double difference = mixture.samples[i] - speech.samples[i];
            energy += speech.samples[i] * speech.samples[i]; noise_energy += difference * difference;
        }
        member->rms = sqrt(energy / (member->end - member->begin));
        if (!(member->rms > 0) || !isfinite(member->rms) || !(noise_energy > 0)) fail("silent summary reference or noise");
        member->gain = 1 / member->rms;
        member->snr = 10 * log10(energy / noise_energy);
        added = allocate(mixture.count, sizeof(double));
        for (size_t i = 0; i < mixture.count; ++i) {
            added[i] = (mixture.samples[i] - speech.samples[i]) * member->gain;
            mixture.samples[i] *= member->gain; speech.samples[i] *= member->gain;
        }
        for (int k = 0; k < 3; ++k) {
            double *samples = k == 0 ? mixture.samples : k == 1 ? speech.samples : added;
            Analysis *analysis = &values[m * 3 + k];
            *analysis = analyze(samples, mixture.count);
            if (analysis->frames > max_frames) max_frames = analysis->frames;
            if (split) for (int part = 0; part < 2; ++part) {
                Analysis measured = analyze(samples + (part ? split : 0), part ? mixture.count - split : split);
                for (int b = 0; b < BINS; ++b) segments[(part * 3 + k) * BINS + b] += measured.psd[b] / count;
                release(&measured);
            }
        }
        free(mixture.samples); free(speech.samples); free(added);
    }
    file = fopen(output, "wb"); if (!file) fail("cannot create summary output");
    fprintf(file, "{\"version\":1,\"sample_rate_hz\":%d,\"nperseg\":%d,\"hop\":%d,\"members\":[", FS, FFT_SIZE, HOP);
    for (int m = 0; m < count; ++m) {
        SummaryMember *member = &members[m];
        fprintf(file, "%s{\"id\":\"%s\",\"sample_count\":%lu,\"start_sample\":%lu,\"end_sample\":%lu,"
            "\"clean_rms\":%.12g,\"normalization_gain\":%.12g,\"actual_snr_db\":%.12g}", m ? "," : "", member->id,
            (unsigned long)member->samples, (unsigned long)member->begin, (unsigned long)member->end,
            member->rms, member->gain, member->snr);
    }
    fputs("],\"signals\":{", file);
    for (int k = 0; k < 3; ++k) {
        const char *names[] = {"mixture", "speech", "added_noise"};
        double mean[BINS] = {0}, low[BINS], high[BINS] = {0};
        Peaks peaks;
        for (int b = 0; b < BINS; ++b) low[b] = DBL_MAX;
        for (int m = 0; m < count; ++m) for (int b = 0; b < BINS; ++b) {
            double value = values[m * 3 + k].psd[b];
            mean[b] += value / count; if (value < low[b]) low[b] = value; if (value > high[b]) high[b] = value;
        }
        peaks = detect(mean);
        fprintf(file, "%s\"%s\":{\"mean_db\":", k ? "," : "", names[k]); vector(file, mean, BINS, 1);
        fputs(",\"min_db\":", file); vector(file, low, BINS, 1);
        fputs(",\"max_db\":", file); vector(file, high, BINS, 1);
        fputs(",\"peaks\":", file); write_peaks(file, &peaks);
        fputs(",\"peak_counts\":[", file);
        for (int p = 0; p < peaks.count && p < TOP_PEAKS; ++p) {
            int matched = 0;
            for (int m = 0; m < count; ++m) matched += summary_match(&values[m * 3 + k].average,
                hz(peaks.peaks[p].bin), peaks.peaks[p].high - peaks.peaks[p].low);
            fprintf(file, "%s%d", p ? "," : "", matched);
        }
        fputs("],\"noise_comparison\":[", file);
        for (int a = 0; a < anchor_count; ++a) {
            int matched = 0;
            double tolerance = MAXIMUM(minimum_match_bins * FS / FFT_SIZE, anchors[a].width * match_width_fraction);
            const Peak *peak = nearest(&peaks, anchors[a].frequency, tolerance);
            for (int m = 0; m < count; ++m) matched += summary_match(&values[m * 3 + k].average, anchors[a].frequency, anchors[a].width);
            fprintf(file, "%s{\"peak_id\":\"p%d\",\"frequency_hz\":%.12g,\"width_hz\":%.12g,\"matched_count\":%d,\"mean_peak_hz\":",
                a ? "," : "", anchors[a].id, anchors[a].frequency, anchors[a].width, matched);
            summary_nullable(file, peak ? hz(peak->bin) : 0, peak != NULL);
            if (split) {
                double before = band_power(segments + k * BINS, anchors[a].low, anchors[a].high);
                double after = band_power(segments + (3 + k) * BINS, anchors[a].low, anchors[a].high);
                fprintf(file, ",\"time_change_db\":%.12g", db(after) - db(before));
            }
            fputc('}', file);
        }
        fputc(']', file);
        if (split) {
            fputs(",\"before_db\":", file); vector(file, segments + k * BINS, BINS, 1);
            fputs(",\"after_db\":", file); vector(file, segments + (3 + k) * BINS, BINS, 1);
        }
        fputs(",\"spectrogram_db\":[", file);
        for (size_t t = 0; t < max_frames; ++t) {
            double average[BINS] = {0}; int valid = 0;
            for (int m = 0; m < count; ++m) if (t < values[m * 3 + k].frames) {
                ++valid;
                for (int b = 0; b < BINS; ++b) average[b] += values[m * 3 + k].frames_psd[t * BINS + b];
            }
            for (int b = 0; b < BINS; ++b) average[b] /= valid;
            if (t) fputc(',', file); vector(file, average, BINS, 1);
        }
        fputs("],\"temporal_peaks\":[", file);
        for (int a = 0; a < anchor_count; ++a) {
            double tolerance = MAXIMUM(minimum_match_bins * FS / FFT_SIZE, anchors[a].width * match_width_fraction);
            fprintf(file, "%s{\"peak_id\":\"p%d\",\"frequency_hz\":%.12g,\"frames\":[", a ? "," : "", anchors[a].id, anchors[a].frequency);
            for (size_t t = 0; t < max_frames; ++t) {
                int valid = 0, matched = 0; double minimum = DBL_MAX, maximum = 0;
                for (int m = 0; m < count; ++m) if (t < values[m * 3 + k].frames) {
                    const Peak *peak = nearest(&values[m * 3 + k].frame_peaks[t], anchors[a].frequency, tolerance);
                    ++valid;
                    if (peak) { double f = hz(peak->bin); ++matched; if (f < minimum) minimum = f; if (f > maximum) maximum = f; }
                }
                fprintf(file, "%s[%d,%.12g,", t ? "," : "", matched, 100.0 * matched / valid);
                summary_nullable(file, minimum, matched); fputc(',', file); summary_nullable(file, maximum, matched); fputc(']', file);
            }
            fputs("]}", file);
        }
        fputs("]}", file);
    }
    fputs("},\"times_sec\":[", file);
    for (size_t t = 0; t < max_frames; ++t) fprintf(file, "%s%.12g", t ? "," : "", (t * (double)HOP + FFT_SIZE / 2) / FS);
    fputs("],\"participant_counts\":[", file);
    for (size_t t = 0; t < max_frames; ++t) {
        int valid = 0;
        for (int m = 0; m < count; ++m) valid += t < values[m * 3].frames;
        fprintf(file, "%s%d", t ? "," : "", valid);
    }
    fprintf(file, "],\"split_sec\":%.12g}\n", (double)split / FS);
    if (ferror(file) || fclose(file)) fail("cannot finish summary output");
    for (int i = 0; i < count * 3; ++i) release(&values[i]);
    free(values); free(members); free(segments);
}
