import Feed from "@/components/Feed";
import { getDb } from "@/lib/db";
import { getPrintedStories } from "@/lib/stories";

export const dynamic = "force-dynamic";

export default function Page() {
  const stories = getPrintedStories(getDb());
  return <Feed stories={stories} now={new Date().toISOString()} />;
}
