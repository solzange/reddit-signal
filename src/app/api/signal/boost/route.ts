import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit } from "@/lib/rate-limit";
import { createHash } from "crypto";

export async function POST(request: NextRequest) {
  const blocked = await rateLimit(request, { limit: 30, windowSeconds: 3600 });
  if (blocked) return blocked;

  let postId: string;
  try {
    const body = await request.json();
    postId = body.postId;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!postId || typeof postId !== "string") {
    return NextResponse.json({ error: "postId required" }, { status: 400 });
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const salt = process.env.CRON_SECRET;
  if (!salt) {
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }
  const ipHash = createHash("sha256")
    .update(ip + salt)
    .digest("hex")
    .slice(0, 32);

  const supabase = createAdminClient();

  const { data: success, error } = await supabase.rpc("boost_post", {
    p_post_id: postId,
    p_ip_hash: ipHash,
  });

  if (error) {
    console.error("signal: boost_post RPC failed:", error);
    return NextResponse.json({ error: "Failed to boost" }, { status: 500 });
  }

  if (!success) {
    return NextResponse.json({ error: "Already boosted" }, { status: 409 });
  }

  return NextResponse.json({ ok: true });
}
