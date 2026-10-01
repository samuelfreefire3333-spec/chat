import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDF88Ir4cGIJx8mDJFR9iRBel2mos2odFY",
  authDomain: "chat-parameuamor.firebaseapp.com",
  projectId: "chat-parameuamor",
  storageBucket: "chat-parameuamor.firebasestorage.app",
  messagingSenderId: "1001981020672",
  appId: "1:1001981020672:web:2e5f49c22e5d8c152d66e5",
  measurementId: "G-48LWQ654D1"
};

const app = initializeApp(firebaseConfig);

// Inicializa o Firestore com Cache Offline Ativado no padrão v10+
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

const storage = getStorage(app);
// initializeAuth em vez de getAuth: as mesmas persistências do getAuth, mas
// SEM o módulo de login por popup/redirecionamento, que o app não usa (o login
// é só por e-mail e senha). Com ele, o SDK carregava em celulares e no Safari
// um iframe de firebaseapp.com e o script apis.google.com/js/api.js — código
// de terceiros desnecessário, que a CSP bloqueia e que gerava relatório de
// violação a cada página aberta.
const auth = initializeAuth(app, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence],
});

export { app, db, storage, auth };