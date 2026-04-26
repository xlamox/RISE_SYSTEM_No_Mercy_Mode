import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBPsgxpBN57IMOhCVaKQe2_bwkZ3aEahjA",
  authDomain: "rise-system-a7135.firebaseapp.com",
  databaseURL: "https://rise-system-a7135-default-rtdb.firebaseio.com",
  projectId: "rise-system-a7135",
  storageBucket: "rise-system-a7135.firebasestorage.app",
  messagingSenderId: "934082504813",
  appId: "1:934082504813:web:319df11b15b82deca3f764",
  measurementId: "G-H0NTG6LWNJ"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { auth, db, signOut, onAuthStateChanged, doc, getDoc, setDoc, updateDoc, onSnapshot };