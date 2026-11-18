export function download(filename, content, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function readServerJSON(path) {
  const response = await fetch(new URL(`../${path}`, location.href), { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const text = (await response.text()).replace(/^\uFEFF/, '').trim();
  return text ? JSON.parse(text) : null;
}
