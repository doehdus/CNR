/* Exact 2.5-second segments, with the existing PSD, detection and linking rules.
 * Input gains come from the registered Clean RMS normalization coefficients. */
static void analyze_peak_periods(const char *manifest, const char *anchor_path, const char *output) {
    Anchor anchors[TOP_PEAKS];
    int anchor_count = 0, count = 0, read;
    FILE *input = fopen(anchor_path, "rb"), *file;
    char line[4096];
    if (!input) fail("cannot read period anchors");
    while (anchor_count < TOP_PEAKS && (read = fscanf(input, "%d,%lf,%lf,%lf,%lf", &anchors[anchor_count].id,
            &anchors[anchor_count].frequency, &anchors[anchor_count].width, &anchors[anchor_count].low, &anchors[anchor_count].high)) == 5) {
        Anchor *a = &anchors[anchor_count];
        if (a->id != anchor_count + 1 || !isfinite(a->frequency) || !isfinite(a->width) || a->width <= 0 ||
            !isfinite(a->low) || !isfinite(a->high) || a->low < 0 || a->high > FS / 2 || a->low >= a->high || a->frequency < a->low || a->frequency > a->high) fail("invalid period anchor");
        ++anchor_count;
    }
    fclose(input);
    if (!anchor_count) fail("missing period anchors");
    input = fopen(manifest, "rb"); if (!input) fail("cannot read period input manifest");
    file = fopen(output, "wb"); if (!file) fail("cannot create period result");
    fputs("{\"version\":1,\"split_sample\":40000,\"records\":[", file);
    while (fgets(line, sizeof(line), input)) {
        char id[64], path[2048], reference[2048]; double gain;
        Wave wave;
        if (sscanf(line, "%63[^\t]\t%lf\t%2047[^\t]\t%2047[^\r\n]", id, &gain, path, reference) != 4 || !isfinite(gain) || gain <= 0 || count >= 64) fail("invalid period manifest");
        for (size_t i = 0; id[i]; ++i) if (!((id[i] >= 'a' && id[i] <= 'z') || (id[i] >= '0' && id[i] <= '9') || id[i] == '_')) fail("invalid period identifier");
        wave = read_wave(path);
        if (wave.count < 40000 + FFT_SIZE) fail("period shorter than one full frame");
        if (strcmp(reference, "-")) {
            Wave clean = read_wave(reference);
            if (clean.count != wave.count) fail("period reference length mismatch");
            for (size_t i = 0; i < wave.count; ++i) wave.samples[i] -= clean.samples[i];
            free(clean.samples);
        }
        for (size_t i = 0; i < wave.count; ++i) wave.samples[i] *= gain;
        fprintf(file, "%s{\"id\":\"%s\",\"normalization_gain\":%.12g,\"periods\":[", count++ ? "," : "", id, gain);
        for (int part = 0; part < 2; ++part) {
            size_t begin = part ? 40000 : 0, samples = part ? wave.count - 40000 : 40000;
            Analysis measured = analyze(wave.samples + begin, samples);
            int eligible = 0;
            int *ids = build_tracking(&measured, 0, samples, &eligible);
            free(ids);
            fprintf(file, "%s{\"period\":\"%s\",\"start_sample\":%lu,\"sample_count\":%lu,\"frame_count\":%lu,\"peaks\":[", part ? "," : "", part ? "after" : "before",
                (unsigned long)begin, (unsigned long)samples, (unsigned long)measured.frames);
            for (int p = 0; p < anchor_count; ++p) {
                Anchor *a = &anchors[p];
                double tolerance = MAXIMUM(minimum_match_bins * FS / FFT_SIZE, a->width * match_width_fraction);
                const Peak *peak = nearest(&measured.average, a->frequency, tolerance);
                const Track *track = near_track(&measured, a->frequency, tolerance);
                fprintf(file, "%s{\"peak_id\":\"p%d\",\"peak_detected\":%s,\"track_id\":", p ? "," : "", a->id, peak ? "true" : "false");
                if (track) {
                    double mean = track->sum / track->count;
                    double variance = track->square / track->count - mean * mean;
                    double deviation = sqrt(MAXIMUM(0, variance));
                    double appearance = 100.0 * track->count / measured.frames;
                    fprintf(file, "%d,\"mean_hz\":%.12g,\"std_hz\":%.12g,\"appearance_percent\":%.12g,\"count\":%d", track->id, mean, deviation, appearance, track->count);
                } else fputs("null,\"mean_hz\":null,\"std_hz\":null,\"appearance_percent\":0,\"count\":0", file);
                fputc('}', file);
            }
            fputs("]}", file); release(&measured);
        }
        fputs("]}", file); free(wave.samples);
    }
    if (ferror(input) || !count) fail("unreadable period inputs");
    fclose(input); fputs("]}\n", file);
    if (ferror(file) || fclose(file)) fail("cannot finish period output");
}
