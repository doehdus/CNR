// Frontend routes retain the public URL while the authored assets live here.
export async function frontendRequest(request: Request, assets?: Fetcher): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/website' && url.pathname !== '/website/') return null;
  if (url.pathname === '/website') return Response.redirect(url.origin + '/website/' + url.search, 302);
  if (!assets) return null;
  const assetURL = new URL('/website/index.html', url);
  const asset = await assets.fetch(new Request(assetURL, request));
  const headers = new Headers(asset.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(asset.body, { status: asset.status, headers });
}
