// Trackly: phone notifications for new alerts (bag left / arrived at a safe zone, battery, parked bag moved).
//  - GET  → { publicKey } for the app to subscribe to notifications
//  - POST → sends every alert that hasn't been sent yet, to the owner and family of that bag
// Called by the database right after each alert (and every 5 minutes as a backup), so calling it often is harmless:
// each alert is "claimed" first and only ever sent once.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const APP_URL = "https://suhaib11111.github.io/trackly/";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// notification text in the phone's language
const TEXT: Record<string, Record<string, string>> = {
  en: { zone_left: "{b} left {z}", zone_arrived: "{b} arrived at {z}", battery_low: "{b}: battery low ({n}%)",
        battery_critical: "{b}: battery almost empty. Last location is saved.", moved: "{b} is moving! It was parked." },
  ckb: { zone_left: "{b} لە {z} دەرچوو", zone_arrived: "{b} گەیشتە {z}", battery_low: "{b}: پاتری کەمە ({n}%)",
         battery_critical: "{b}: پاتری خەریکە تەواو دەبێت. دوایین شوێن پاشەکەوت کراوە.", moved: "{b} دەجووڵێت! ڕاگیرابوو." },
  ar: { zone_left: "{b} غادرت {z}", zone_arrived: "{b} وصلت إلى {z}", battery_low: "{b}: البطارية منخفضة ({n}%)",
        battery_critical: "{b}: البطارية على وشك النفاد. تم حفظ آخر موقع.", moved: "{b} تتحرك! كانت مركونة." },
};
const fill = (s: string, v: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));

// deno-lint-ignore no-explicit-any
async function vapidKeys(db: any) {
  const { data } = await db.from("app_keys").select("key,value").in("key", ["vapid_public", "vapid_private"]);
  let pub = data?.find((k: { key: string }) => k.key === "vapid_public")?.value;
  let priv = data?.find((k: { key: string }) => k.key === "vapid_private")?.value;
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    // only the first call wins (primary key), then everyone reads the same keys
    await db.from("app_keys").upsert([{ key: "vapid_public", value: k.publicKey }, { key: "vapid_private", value: k.privateKey }], { onConflict: "key", ignoreDuplicates: true });
    const again = await db.from("app_keys").select("key,value").in("key", ["vapid_public", "vapid_private"]);
    pub = again.data?.find((x: { key: string }) => x.key === "vapid_public")?.value;
    priv = again.data?.find((x: { key: string }) => x.key === "vapid_private")?.value;
  }
  return { pub, priv };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { pub, priv } = await vapidKeys(db);
  if (!pub || !priv) return json({ error: "not set up" }, 500);
  if (req.method === "GET") return json({ publicKey: pub });
  if (req.method !== "POST") return json({ error: "GET or POST" }, 405);

  webpush.setVapidDetails(APP_URL, pub, priv);
  const since = new Date(Date.now() - 6 * 3600e3).toISOString();
  const { data: pending, error } = await db.from("alerts").select("id, tracker_id, owner_id, kind, zone_name, battery")
    .is("pushed_at", null).gte("created_at", since).order("id").limit(50);
  if (error) return json({ error: "alerts table missing" }, 500);

  let sent = 0;
  for (const a of pending ?? []) {
    // claim it first, so two calls at the same moment never notify twice
    const { data: claimed } = await db.from("alerts").update({ pushed_at: new Date().toISOString() }).eq("id", a.id).is("pushed_at", null).select("id");
    if (!claimed?.length) continue;
    const { data: tr } = await db.from("trackers").select("name, device_code").eq("id", a.tracker_id).maybeSingle();
    const { data: members } = await db.from("tracker_members").select("user_id").eq("tracker_id", a.tracker_id);
    const people = [a.owner_id, ...(members ?? []).map((m: { user_id: string }) => m.user_id)];
    const { data: subs } = await db.from("push_subscriptions").select("endpoint, sub, lang").in("user_id", people);
    for (const s of subs ?? []) {
      const t = TEXT[s.lang] ?? TEXT.en;
      const body = fill(t[a.kind] ?? a.kind, { b: tr?.name || tr?.device_code || "Trackly", z: a.zone_name ?? "", n: a.battery ?? "" });
      try {
        await webpush.sendNotification(s.sub, JSON.stringify({ title: "Trackly", body, url: APP_URL, tag: "trackly-" + a.tracker_id + "-" + a.kind }),
          { TTL: 6 * 3600, urgency: a.kind === "moved" || a.kind === "zone_left" ? "high" : "normal" });
        sent++;
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await db.from("push_subscriptions").delete().eq("endpoint", s.endpoint); // phone unsubscribed
      }
    }
  }
  return json({ sent });
});
