# Mobile client

The Expo + React Native app supports student sign-in/account creation, profile updates, document metadata submission, recommendations, and interview practice. JWTs are stored with Expo SecureStore. The document endpoint currently records metadata only; the backend does not store or inspect uploaded file bytes.

## Configure and run

Create `mobile/.env.local` with a backend URL reachable from the device:

```dotenv
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.20:8000/api
```

Replace the example address with the development computer's LAN address. Do not use `localhost` on a physical phone. The Android emulator can use `http://10.0.2.2:8000/api`; an iOS simulator can use `http://127.0.0.1:8000/api`. The API address is public configuration, not a secret.

```powershell
cd mobile
npm install
npm start
```

`npm run build` creates an Android JavaScript bundle with Expo; it is not a signed APK/AAB. Install Android Studio/SDK or use an Expo development build to run on an emulator/device.
