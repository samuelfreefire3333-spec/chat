import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

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
const auth = getAuth(app);

export { app, db, storage, auth };