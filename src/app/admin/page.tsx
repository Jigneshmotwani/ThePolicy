import type { Metadata } from "next";
import { cookies } from "next/headers";
import Console from "@/components/Console";
import { COOKIE, isValidSession } from "@/lib/adminAuth";
import { getDb } from "@/lib/db";
import "./admin.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Newsroom console · The Second Source", robots: { index: false, follow: false } };

export default async function AdminPage() {
  // The page shell holds no data: everything comes from /api/admin/*, which checks the session on every call.
  const token = (await cookies()).get(COOKIE)?.value;
  return <Console initialAuthed={isValidSession(getDb(), token)} />;
}
