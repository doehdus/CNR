import { localPath } from './dataset.js';
export const SS_METHODS = ['input', 'ss1', 'ss5'];
export const SS_NOISES = {single: '단일 소음', complex: '복합 소음', changing: '변화 소음'};
export function normalizeSSFixed(data) {
  const fail = () => { throw Error('고정형 SS 자료의 조건·점수·설정을 확인하세요.'); };
  if (data?.version !== 1 || data.status !== 'completed' || data.conditions?.length !== 288 || data.recordings?.length !== 12 || data.summary?.length !== 4) fail();
  if (JSON.stringify(data.settings.alphas) !== '[1,5]' || data.settings.beta !== 0.02 || data.settings.noise_update !== false || data.settings.volume_normalization !== false) fail();
  const ids = new Set(data.recordings.map(r => r.id));
  if (ids.size !== 12) fail();
  const seen = new Set();
  for (const row of data.conditions) {
    if (!['butterworth1','butterworth2'].includes(row.bpf) || !Object.hasOwn(SS_NOISES,row.noise) || ![0,5,10,20].includes(row.snr_db) || !ids.has(row.statement)) fail();
    const key = [row.bpf,row.noise,row.snr_db,row.statement].join('/');
    if (seen.has(key) || !Number.isSafeInteger(row.alignment_delay_samples) || !Number.isSafeInteger(row.compared_samples) || row.compared_samples < 1) fail();
    seen.add(key);
    for (const method of SS_METHODS) {
      const item = row.methods?.[method];
      if (!item || localPath(item.path) !== item.path || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 44) fail();
      for (const metric of ['stoi','estoi']) if (!Number.isFinite(item[metric]) || Math.abs(item[metric]) > 1) fail();
    }
  }
  for (const bpf of ['butterworth1','butterworth2']) for (const alpha of [1,5]) {
    const summary = data.summary.filter(s => s.bpf === bpf && s.alpha === alpha);
    if (summary.length !== 1 || summary[0].count !== 144) fail();
    const rows = data.conditions.filter(r => r.bpf === bpf);
    for (const metric of ['stoi','estoi']) {
      const mean = rows.reduce((n,r) => n+r.methods['ss'+alpha][metric],0)/144;
      const baseline = rows.reduce((n,r) => n+r.methods.input[metric],0)/144;
      if (Math.abs(mean-summary[0][metric+'_mean']) > 1e-10 || Math.abs(mean-baseline-summary[0]['delta_'+metric+'_mean']) > 1e-10) fail();
    }
  }
  return data;
}
export function selectSSConditions(data, {bpf, noise, snr}) {
  return data.conditions.filter(r => r.bpf === bpf && r.noise === noise && r.snr_db === Number(snr));
}
