nodeplayer-backend-gmusic
=========================

gmusic backend for nodeplayer

Setup
-----

* Log in to the `Google Play Music` Android application at least once before
  using backend (restriction of the unofficial API)
* Enable backend `gmusic` in: `~/.nodeplayer/config/core.json`
* Run nodeplayer once to generate sample config file: `npm start`
* Create an [app password](https://security.google.com/settings/security/apppasswords)
* Edit `~/.nodeplayer/config/gmusic.json`, replace email with your gmail and
  password with the generated app password.
