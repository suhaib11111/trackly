// Trackly settings
// The publishable key is safe to use in the browser. Never put a secret / service_role key here.
window.TRACKLY_CONFIG = {
  // true  = TEST MODE: pretend login + pretend tracker, saved in this browser only (see js/fake-backend.js)
  // false = the real Supabase project below
  // Test mode (pretend data in this browser) unless "Real database" is switched on in Account.
  fakeBackend: (() => { try { return localStorage.getItem('trackly-backend') !== 'real'; } catch (e) { return true; } })(),
  // Google sign-in: set to true after setting it up (docs/google-login.md)
  googleLogin: false,

  // test mode only: the pretend tracker follows THIS phone's real GPS (needs https). false = pretend route in Erbil
  usePhoneGps: true,

  supabaseUrl: 'https://lcrvuijwpvhphbuwxtny.supabase.co',
  supabaseKey: 'sb_publishable_pW_dqVXVi9PMOH8FjPpa6g_VI_GQ2rF',

  // Tracker timing (must match the ESP32 code)
  normalIntervalMin: 1.5,   // normal mode sends every 1–1.5 min while moving
  stillCheckinMin: 60,      // hourly check-in when the bag is still
  lowBatteryPercent: 20,
  lostBatteryHoursAtFull: 24 // about 1 day at 100% in lost mode
};
