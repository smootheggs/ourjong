# Ourjong for Android

A small native shell around the web game in `apps/client`, which it carries inside the APK:
fully offline, no permissions at all, and the hand in progress survives turning the tablet.

GitHub Actions builds it (`.github/workflows/android.yml`): the web game is built in one job
without any secrets, then packed and signed in another, and each signed build of `main` is
published as a release (`ourjong-v…`) for Obtainium.

Building by hand:

```
npm ci
OURJONG_APK=1 npm run build -w client
mkdir -p android/app/src/main/assets/www
cp -r apps/client/dist/* android/app/src/main/assets/www/
cd android && gradle :app:assembleDebug
```

`OURJONG_APK=1` leaves out the PWA's service worker, which the APK doesn't need.
