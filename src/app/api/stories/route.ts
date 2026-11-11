import { getDb } from "@/lib/db";
import { getPrintedStories } from "@/lib/stories";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return Response.json(getPrintedStories(getDb()), {
    headers: { "Cache-Control": "no-store" },
  });
}
