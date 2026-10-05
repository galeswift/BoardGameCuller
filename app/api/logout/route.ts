import { SESSION_COOKIE } from "../../auth";
export const dynamic = "force-dynamic";

export async function POST() {
  return new Response(null, {
    status: 303,
    headers: { Location: "/login", "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` },
  });
}
