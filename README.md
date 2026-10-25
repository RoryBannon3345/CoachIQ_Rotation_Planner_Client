# CoachIQ_Rotation_Planner_Client (forwarder)

This repo only forwards the old CoachIQ Stats phone address to the renamed app, SixUpIQ Stats:

https://rorybannon3345.github.io/SixUpIQ_Stats/SixUpIQ_Stats.html

It holds a one-page redirect (served at the old file name and at the folder root) and a service worker that replaces the old app's one on phones that installed it. The service worker stays installed: it deletes the old app's caches (only those whose names start with `ciq-`, never the new app's `sixupiq-` ones), reloads open pages, and answers every page load at the old address with a redirect to the new one. That redirect needs no network, so an old home-screen icon still opens SixUpIQ Stats offline once it has been forwarded online once. It keeps no cache of its own. The query string and hash are passed through.

It exists so that home-screen icons, bookmarks and QR codes from CoachIQ-era rosters keep working, and so the phone's saved session (kept on the github.io origin) is still found.

**When it can be retired:** once no coach still opens the old address. Delete this repo (or its Pages site) then. Until then, leave it: the old repo name must stay taken, or someone else could register it.
