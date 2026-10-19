# Tracker beep: what to add to the ESP32 code

The app's **Beep** / **Play sound** button calls `request_buzz` in Supabase.
The tracker picks it up by calling `device_poll` right after each `report_location`.
(Needs `supabase/proposed/002_security_alerts_sharing.sql` to be run first.)

`device_poll` answers `{"mode":"normal","buzz":true}`. A beep request is used once,
and is ignored if it is older than 10 minutes.

## Arduino / ESP32 code to add

```cpp
// After your report_location call succeeds:
bool checkBuzz() {
  HTTPClient http;
  http.begin(String(SUPABASE_URL) + "/rest/v1/rpc/device_poll");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_KEY);                 // the same publishable key you use now
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);
  String body = String("{\"p_code\":\"") + DEVICE_CODE + "\",\"p_secret\":\"" + DEVICE_SECRET + "\"}";
  int code = http.POST(body);
  String res = http.getString();
  http.end();
  return code == 200 && (res.indexOf("\"buzz\": true") >= 0 || res.indexOf("\"buzz\":true") >= 0);
}

void beep() {
  // 3 short beeps, about 2 seconds in total
  for (int i = 0; i < 3; i++) {
    tone(BUZZER_PIN, 2800, 400);
    delay(650);
  }
}

// in loop(), after sending the location:
if (checkBuzz()) beep();
```

## Notes
- In **lost mode** the tracker reports every 5 s, so the beep comes within ~5 s.
- In **normal mode** it comes at the next report (1–1.5 min when moving, up to 1 h when still).
- Lost mode stays silent on its own; the beep only plays when the owner asks for it.
