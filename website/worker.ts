import handler from "vinext/server/fetch-handler";
import { researchRequest } from './backend/api/research.ts';
import { frontendRequest } from './src/handler.ts';

const worker = {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    const response = await researchRequest(request, env);
    if (response) return response;
    const page = await frontendRequest(request, env.ASSETS);
    if (page) return page;
    return handler.fetch(request, env, ctx);
  },
};

export default worker;
