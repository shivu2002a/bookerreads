import { NextResponse, type NextRequest } from "next/server";
import { refreshSupabaseSession } from "@/lib/supabase/middleware";

const MEMBER_PREFIXES = ["/shelf", "/requests", "/loans", "/activate", "/earnings", "/profile"];

function isMemberRoute(pathname: string) {
  return MEMBER_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function middleware(request: NextRequest) {
  const { response, user } = await refreshSupabaseSession(request);
  const { pathname } = request.nextUrl;

  if (!user && (isMemberRoute(pathname) || pathname.startsWith("/admin"))) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Onboarding completeness (display name, cluster) and admin gating are
  // checked in the route-group layouts, where the member row is available.
  return response;
}

export const config = {
  matcher: [
    // Skip static assets, images, and the PWA shell files.
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|icons/|.*\\.(?:png|jpg|jpeg|svg|webp|ico)$).*)",
  ],
};
