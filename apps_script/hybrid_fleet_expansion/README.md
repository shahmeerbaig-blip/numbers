# Hybrid Fleet Expansion — Apps Script port

Google Apps Script web app version of the Hybrid Fleet Expansion planning tool
(Leaflet map + sliders for service radius / hybrid feasibility % / order growth %).

## ⚠️ Data gap to fix before deploying

Two arrays in `Index.html` are placeholders, not the real data:

- `deliveryLocations` — should hold ~918 `{lat, lng, orders}` grid points (order
  density). Only 6 sample points are in there now.
- `coveragePolygons` — should hold the 11 existing branches' real coverage-area
  boundaries (`{coords: [[lng, lat], ...], color}`). It's currently empty.

Without the real `deliveryLocations`, the "Additional Orders" / "Hybrid Feasible
Orders" numbers will be near zero for every candidate store. Replace both arrays
with the original data (from the source `talabat_hybrid_fleet_expansion.html`
file) before relying on the numbers.

`existingStores` (11 branches) and `newStores` (9 candidates) are complete and
unchanged.

## Deploy

Option A — paste into the Apps Script editor:
1. Go to [script.google.com](https://script.google.com) → New project.
2. Replace the default `Code.gs` content with this folder's `Code.gs`.
3. Add an HTML file named `Index` and paste this folder's `Index.html` into it.
4. Open **Project Settings → appsscript.json** (or enable "Show manifest file"
   in editor settings) and replace it with this folder's `appsscript.json`.
5. Deploy → New deployment → Web app. Choose who has access (this repo's
   manifest defaults to "Only myself" — change to your domain or "Anyone" as
   needed since the data includes real store locations and order volumes).

Option B — [`clasp`](https://github.com/google/clasp):
```bash
cd apps_script/hybrid_fleet_expansion
clasp create --type webapp --title "Hybrid Fleet Expansion"
clasp push
clasp deploy
```

## Notes
- The page is fully static (no server-side Apps Script logic beyond serving the
  HTML) — all map rendering and the coverage-gain calculation run client-side,
  identical to the original tool.
- Leaflet and the Poppins font are loaded from their public CDNs; Apps Script's
  web app iframe allows this without extra configuration.
