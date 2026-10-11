# Hypno

Hypno is a Castalia Institute research and design project exploring an AI guide for immersive hypnotic experiences. The concept brings conversational guidance together with generated narration, sound, and visual environments, with a phone-based VR viewer in the spirit of Google Cardboard as an initial interface direction.

The `/app/` route is an installable, offline-capable PWA prototype. It composes a short guided session in the browser, uses the device's speech synthesis for narration, generates a quiet ambient tone with Web Audio, and draws a slow procedural scene. Cardboard view presents the scene side-by-side for a phone viewer.

The prototype is local-first: there is no connected AI model, microphone access, recording, account, or session history. Guide language is assembled from local templates; the app does not send session choices anywhere. This is a creative experience, not medical care or treatment.

- Site: <https://hypno.castalia.institute>
- App: <https://hypno.castalia.institute/app/>
- Repository: <https://github.com/CastaliaInstitute/hypno>
- Hosting: GitHub Pages from the root of `main`

## Local preview

Run `python3 -m http.server` from the repository root and open <http://localhost:8000> or <http://localhost:8000/app/>. The service worker is enabled on localhost and on the published HTTPS site.
