import { handleAdmin } from "@/lib/adminApi";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ path: string[] }> };

// One handler for every admin route: handleAdmin checks the session before anything else.
export async function GET(req: Request, ctx: Ctx) {
  return handleAdmin(req, (await ctx.params).path, getDb());
}
export async function POST(req: Request, ctx: Ctx) {
  return handleAdmin(req, (await ctx.params).path, getDb());
}
