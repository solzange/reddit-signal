import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSignalConfig } from "@/signal.config";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!token || !UUID_RE.test(token)) {
    return new NextResponse("Invalid token", { status: 400 });
  }

  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("signal_subscribers")
    .update({ confirmed: true })
    .eq("confirmation_token", token)
    .is("unsubscribed_at", null)
    .select("email")
    .maybeSingle();

  if (error || !data) {
    return new NextResponse(
      `<html><body style="font-family:monospace;background:#0A0A0B;color:#E0E0E0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center">
          <p style="font-size:18px">Invalid or expired link.</p>
          <a href="/" style="color:#4EC9B0;font-size:14px">Back to the feed</a>
        </div>
      </body></html>`,
      { status: 400, headers: { "Content-Type": "text/html" } }
    );
  }

  const config = getSignalConfig();
  const siteUrl = config.siteUrl || process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  return NextResponse.redirect(`${siteUrl}?subscribed=1`);
}
