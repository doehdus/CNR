const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const run = x => typeof x === 'string' && /^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(x);
const finite = x => typeof x === 'number' && Number.isFinite(x);
const integer = x => Number.isSafeInteger(x) && x >= 0;
const fail = () => { throw Error('필터링 지표의 조건·기준음·계산 구간·출처를 확인하세요.'); };
const near = (a,b) => Math.abs(a-b) <= 1e-10;
export function normalizePrefilterMetrics(data) {
  if(data?.version!==1 || data.status!=='completed' || !run(data.run_id) || !run(data.bpf_run_id) ||
      data.actual_count!==144 || data.planned_count!==144 || data.scored_audio_count!==288 || data.score_value_count!==576 || data.reference_count!==12 ||
      !hash(data.bpf_manifest_sha256) || !hash(data.reference_catalog_sha256) || !hash(data.engine?.source_sha256) || !hash(data.engine?.runner_sha256) ||
      typeof data.tool_version!=='string' || !data.tool_version.startsWith('pystoi/0.4.1;') ||
      data.settings?.sample_rate_hz!==16000 || !finite(data.settings.max_delay_seconds) || data.settings.max_delay_seconds<0 ||
      data.settings.alignment!=='absolute_cross_correlation_then_common_clean_interval' || data.settings.clean_reference!=='unfiltered_registered_reference' ||
      data.settings.baseline!=='original_mixture_no_extra_gain' || data.settings.filtered!=='stored_butterworth_wav_including_minus_1db_headroom' ||
      !Array.isArray(data.recordings) || data.recordings.length!==12 || !Array.isArray(data.conditions) || data.conditions.length!==144 ||
      !Array.isArray(data.summaries) || data.summaries.length!==5 || !hash(data.artifacts?.['comparison.csv'])) fail();
  const recordings=new Map();
  for(const r of data.recordings) {
    if(!/^(instruction|warning)0[1-6]$/.test(r?.id) || recordings.has(r.id) || typeof r.text!=='string' || !r.text.trim() || typeof r.speaker!=='string' || !r.speaker.trim()) fail();
    recordings.set(r.id,r);
  }
  const seen=new Set();
  for(const r of data.conditions) {
    const key=[r.noise,r.snr,r.statement].join('/'),suffix=r.noise+'/snr'+String(r.snr).padStart(2,'0')+'/'+r.statement+'.wav';
    if(!['single','complex','changing'].includes(r.noise) || ![20,10,5,0].includes(r.snr) || !recordings.has(r.statement) ||
        r.speaker!==recordings.get(r.statement).speaker || seen.has(key) || r.input_path!=='data/mixed/'+suffix ||
        r.output_path!=='outputs/prefilter_bpf/runs/'+data.bpf_run_id+'/'+suffix || r.reference_path!=='data/reference/'+r.statement+'.wav' ||
        !['input_sha256','output_sha256','reference_sha256'].every(k=>hash(r[k])) ||
        !integer(r.reference_start) || !integer(r.reference_stop) || !integer(r.samples) || r.samples<=0 || r.reference_stop-r.reference_start!==r.samples) fail();
    seen.add(key);
    for(const mode of ['baseline','filtered']) {
      const p=r[mode]?.alignment;
      if(p?.sample_rate!==16000 || p.reference_sample_rate!==16000 || p.compared_sample_rate!==16000 ||
          !Number.isSafeInteger(p.alignment_delay_samples) || !finite(p.alignment_correlation) || Math.abs(p.alignment_correlation)>1+1e-10 ||
          p.alignment_max_delay_seconds!==data.settings.max_delay_seconds || Math.abs(p.alignment_delay_samples)>data.settings.max_delay_seconds*16000 ||
          !['samples','reference_trim_start','reference_trim_end','compared_trim_start','compared_trim_end'].every(k=>integer(p[k])) ||
          r.reference_start<p.reference_trim_start || r.reference_stop>p.reference_trim_start+p.samples ||
          !integer(r[mode].scored_target_start) || r[mode].scored_target_start!==r.reference_start+p.alignment_delay_samples) fail();
    }
    for(const metric of ['stoi','estoi']) {
      if(!['baseline','filtered','delta'].every(k=>finite(r[k]?.[metric])) || Math.abs(r.baseline[metric])>1 || Math.abs(r.filtered[metric])>1 ||
          !near(r.delta[metric],r.filtered[metric]-r.baseline[metric])) fail();
    }
  }
  const summaries=new Set();
  for(const s of data.summaries) {
    if(![null,20,10,5,0].includes(s.snr) || summaries.has(s.snr)) fail(); summaries.add(s.snr);
    const rows=s.snr===null?data.conditions:data.conditions.filter(r=>r.snr===s.snr);
    if(s.count!==rows.length) fail();
    for(const metric of ['stoi','estoi']) for(const mode of ['baseline','filtered','delta']) {
      if(!finite(s[metric]?.[mode]) || !near(s[metric][mode],rows.reduce((sum,r)=>sum+r[mode][metric],0)/rows.length)) fail();
    }
  }
  return data;
}
export function prefilterMetricInputsMatch(data,fingerprints) {
  return Boolean(data && data.conditions.every(r=>['input','output','reference'].every(k=>fingerprints[r[k+'_path']]===r[k+'_sha256'])));
}
export function prefilterMetricBpfMatches(data,bpf) {
  if(!data || !bpf || data.bpf_run_id!==bpf.run_id) return false;
  const rows=new Map(bpf.conditions.map(r=>[[r.noise,r.snr,r.statement].join('/'),r]));
  return data.conditions.every(r=>{ const b=rows.get([r.noise,r.snr,r.statement].join('/')); return b&&['input_path','input_sha256','output_path','output_sha256','speaker'].every(k=>r[k]===b[k]); });
}
