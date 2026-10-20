// Trackly: "Delete my account". Deletes the signed-in person's account and everything that belongs to it.
// The caller is identified from their login token (verify_jwt on), so it can only ever delete itself.
// Trackers they own are freed (history, zones, links, family access deleted) so they can be paired again.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who?.user) return json({ error: "not signed in" }, 401);
  const uid = who.user.id;

  // tables from later updates may not exist yet: ignore "missing table" errors
  const del = async (table: string, col: string, val: string | string[]) => {
    const q = admin.from(table).delete();
    const { error } = Array.isArray(val) ? await q.in(col, val) : await q.eq(col, val);
    if (error && !/does not exist|schema cache/i.test(error.message)) throw new Error(table + ": " + error.message);
  };
  try {
    const { data: mine } = await admin.from("trackers").select("id").eq("owner_id", uid);
    const ids = (mine ?? []).map((t: { id: string }) => t.id);
    if (ids.length) {
      for (const t of ["tracker_members", "member_invites", "share_links", "safe_zones", "alerts", "locations"]) await del(t, "tracker_id", ids);
      await admin.from("trackers").update({ owner_id: null, name: null, color: null, mode: "normal" }).in("id", ids);
    }
    await del("tracker_members", "user_id", uid);   // family access to other people's bags
    await del("push_subscriptions", "user_id", uid);
    await del("claim_attempts", "user_id", uid);
    await del("app_admins", "user_id", uid);
    const { error } = await admin.auth.admin.deleteUser(uid);
    if (error) throw error;
    return json({ deleted: true });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
