# Live traffic on the map (optional)

Trackly can colour the roads by traffic (green = free, orange = slow, red = jammed) using TomTom.
TomTom gives a free key (2,500 map requests a day, no card needed).

1. Go to https://developer.tomtom.com and click **Register** (free).
2. After logging in, open **Dashboard → Keys** and copy the key called "My first API key".
3. Open `js/config.js` and paste it: `tomtomKey: 'YOUR-KEY-HERE',`
4. Commit and push. In Trackly, open the map-style menu (layers button) → **Live traffic**.

Coverage in Iraq is best on main city roads (Erbil, Baghdad, Sulaymaniyah). If the key is empty, the switch is hidden.
