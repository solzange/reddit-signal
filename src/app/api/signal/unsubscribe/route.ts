import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!token || !UUID_RE.test(token)) {
    return new NextResponse("Invalid token", { status: 400 });
  }

  const supabase = createAdminClient();

  const { error } = await supabase
    .from("signal_subscribers")
    .update({ unsubscribed_at: new Date().toISOString() })
    .eq("confirmation_token", token);

  if (error) {
    console.error("signal: Failed to unsubscribe:", error);
  }

  return new NextResponse(
    `<html><body style="font-family:monospace;background:#0A0A0B;color:#E0E0E0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
      <div style="text-align:center">
        <p style="font-size:18px;color:#4EC9B0">Unsubscribed</p>
        <p style="font-size:14px;color:#9A9AAA;margin-top:12px">You won't receive the weekly digest anymore.</p>
        <a href="/" style="color:#4EC9B0;font-size:14px;margin-top:24px;display:inline-block">Back to the feed</a>
      </div>
    </body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
