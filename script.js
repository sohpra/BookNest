/* ===================== BOOKNEST (FAMILY MODE v1) ===================== */
/* Keeps: Auth UI, Scanner (Quagga), Lookups, Filters, UI flow
   Changes: Data model => families/{familyId}/...
   - Shared shelf default
   - Private shelf per user
   - Per-user read stored in userData subcollection
   - Auto-creates a family vault on first login ("Our BookNest")
   - Adds: join existing family via ?join=FAMILY_ID (optional, for invites)
*/

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import {
  getFirestore,
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  deleteDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ===================== FIREBASE CONFIG ===================== */
const firebaseConfig = {
  apiKey: "AIzaSyB7hH4O_dKpc1tpvG_OpCtwlcJ23wcIT5g",
  authDomain: "booknest-af892.firebaseapp.com",
  projectId: "booknest-af892",
  storageBucket: "booknest-af892.firebasestorage.app",
  messagingSenderId: "210559796706",
  appId: "1:210559796706:web:c1e50148e6d9f5286ce5bb",
};


const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

onAuthStateChanged(auth, async (user) => {
  if (user) {
    // ─── LOGGED IN ───
    currentUser = user;

    $("authStatus").textContent = `Logged in as ${user.email}`;
    show($("logoutBtn"), true);
    show($("openAuthBtn"), false);

    setHomeAuthState(true); // ✅ NEW

    // Ensure family + load data
    await ensureFamilyVault();
    await loadLibrary();

    showView("view-home");

  } else {
    // ─── LOGGED OUT ───
    currentUser = null;
    familyId = null;
    myLibrary = [];

    $("authStatus").textContent = "Not logged in";
    show($("logoutBtn"), false);
    show($("openAuthBtn"), true);

    renderLibrary([]);
    updateHomeStats();

    setHomeAuthState(false); // ✅ NEW

    showView("view-home");
  }
});



/* ===================== CONFIG ===================== */
const Quagga_CDN = "https://cdn.jsdelivr.net/npm/@ericblade/quagga2/dist/quagga.min.js";
// Leave as "" to skip Google Books and use OpenLibrary only.
const GOOGLE_BOOKS_API_KEY = ""; // optional

/* ===================== STATE ===================== */
let currentUser = null; // Firebase user
let familyId = null; // current family vault id
let myLibrary = []; // merged: shared + private (with per-user read)
let scannerActive = false;
let detectionLocked = false;
let mediaStream = null;
let skipNextLibraryReload = false;

let lastCode = null;
let sameCount = 0;
let lastAcceptTs = 0;

let librarySyncInFlight = false;

/* ===================== DOM HELPERS ===================== */
const $ = (id) => document.getElementById(id);
function show(el, yes) {
  if (el) el.style.display = yes ? "" : "none";
}

function getJoinFamilyId() {
  const p = new URLSearchParams(window.location.search);
  const id = (p.get("join") || "").trim();
  return id || null;
}



/* ===================== URL PARAMS (optional invites) ===================== */
//const params = new URLSearchParams(location.search);
//const JOIN_FAMILY_ID = (params.get("join") || "").trim(); // e.g. ?join=abc123

/* ===================== FAMILY DATA PATHS ===================== */
// Index from user -> family
function userIndexRef(uid) {
  return doc(db, "userIndex", uid);
}

function familyRef(fid) {
  return doc(db, "families", fid);
}

function memberRef(fid, uid) {
  return doc(db, "families", fid, "members", uid);
}

// Shelves (denormalised docs with metadata for fast list rendering)
function sharedShelfCol(fid) {
  return collection(db, "families", fid, "books");
}
function privateShelfCol(fid, uid) {
  return collection(db, "families", fid, "privateShelves", uid, "books");
}
function bookMetaRef(fid, bookId) {
  return doc(db, "families", fid, "books", bookId);
}


// Per-user data for a book (read, rating, notes, tags etc)
function userDataRef(fid, bookId, uid) {
  return doc(db, "families", fid, "books", bookId, "userData", uid);
}

/* ===================== FAMILY BOOTSTRAP ===================== */
function newId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
}

/**
 * ensureFamilyVault()
 * - If user already linked in userIndex -> use it
 * - Else if URL has ?family=... -> join that family
 * - Else -> create a new family vault + make this user parent
 */
async function ensureFamilyVault() {
  if (!currentUser) return null;

  // 1) Already linked?
  try {
    const idx = await getDoc(userIndexRef(currentUser.uid));
    if (idx.exists() && idx.data()?.familyId) {
      familyId = idx.data().familyId;
      return familyId;
    }
  } catch {
    // ignore, we'll try to bootstrap below
  }

  // 2) Join an existing family (invite link flow)

  const joinId = getJoinFamilyId();
  if (joinId) {
    const fid = joinId;


    // Does family exist?
    const famSnap = await getDoc(familyRef(fid));
    if (!famSnap.exists()) {
      showToast("Invite link invalid (family not found)", "#dc3545");
    } else {
      // Create member doc for this user (role defaults to child)
      await setDoc(
        memberRef(fid, currentUser.uid),
        {
          name: currentUser.email || "Member",
          role: "child",
          joinedAt: serverTimestamp(),
        },
        { merge: true }
      );

      // Link user -> family
      await setDoc(
        userIndexRef(currentUser.uid),
        {
          familyId: fid,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      familyId = fid;
      history.replaceState({}, "", location.pathname);
      return familyId;
    }
  }

  /* ===================== PIN LOGIN ===================== */

/* async function loginWithPin(pin, name) {
  if (!familyId) return false;

  const q = await getDoc(doc(db, "families", familyId, "pins", pin));
  if (!q.exists()) return false;

  const pinUser = q.data();

  await setDoc(memberRef(familyId, pinUser.uid), {
    name: name || pinUser.name,
    role: "child",
    joinedAt: serverTimestamp(),
  });

  await setDoc(userIndexRef(pinUser.uid), { familyId }, { merge: true });
  return true;
}

/* ===================== FAMILY JOIN LINKS ===================== */
/*
function getJoinFamilyFromURL() {
  const p = new URLSearchParams(window.location.search);
  return p.get("join");
}

async function tryJoinFamily() {
  const joinId = getJoinFamilyFromURL();
  if (!joinId || !currentUser) return false;

  await setDoc(memberRef(joinId, currentUser.uid), {
    name: currentUser.email || "Family Member",
    role: "child",
    joinedAt: serverTimestamp(),
  });

  await setDoc(userIndexRef(currentUser.uid), {
    familyId: joinId,
    updatedAt: serverTimestamp(),
  });

  familyId = joinId;
  return true;
}


async function createKidPin(pin, name) {
  if (!familyId) return;

  const kidUid = newId();

  await setDoc(doc(db, "families", familyId, "pins", pin), {
    name,
    uid: kidUid,
    createdAt: serverTimestamp(),
  });
}

  function getJoinFamilyFromURL() {
  const p = new URLSearchParams(window.location.search);
  return p.get("join");
}

async function tryJoinFamily() {
  const joinId = getJoinFamilyFromURL();
  if (!joinId || !currentUser) return false;

  // Attach user to that family
  await setDoc(memberRef(joinId, currentUser.uid), {
    name: currentUser.email || "Family Member",
    role: "child",
    joinedAt: serverTimestamp(),
  });

  await setDoc(userIndexRef(currentUser.uid), {
    familyId: joinId,
    updatedAt: serverTimestamp(),
  });

  familyId = joinId;
  return true;
}*/
  // 3) Create a new family vault for this parent (v1 behaviour)
  familyId = newId();

  await setDoc(
    familyRef(familyId),
    {
      name: "Our BookNest",
      createdBy: currentUser.uid,
      createdAt: serverTimestamp(),
    },
    { merge: true }
  );

  await setDoc(
    memberRef(familyId, currentUser.uid),
    {
      name: currentUser.email || "Parent",
      role: "parent",
      joinedAt: serverTimestamp(),
    },
    { merge: true }
  );

  await setDoc(
    userIndexRef(currentUser.uid),
    {
      familyId,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  return familyId;
}

/* ===================== AUTH UI ===================== */
function setAuthUI() {
  const status = $("authStatus");
  const logoutBtn = $("logoutBtn");
  const openAuthBtn = $("openAuthBtn");
  //const loginHint = $("loginHint");

  if (!status || !openAuthBtn || !logoutBtn) return;

  if (currentUser) {
    status.textContent = `Logged in as ${currentUser.email}`;
    show(logoutBtn, true);
    show(openAuthBtn, false); // hide login button entirely
    //show(loginHint, false);
  } 
  else {
    status.textContent = "Not logged in";
    show(logoutBtn, false);
    show(openAuthBtn, true);
    openAuthBtn.textContent = "Log in";
    //show(loginHint, true);
  }

}

function setHomeAuthState(isLoggedIn) {
  show($("home-auth-only"), isLoggedIn);
  show($("home-logged-out"), !isLoggedIn);
}


function bindAuthModal() {
  const modal = $("auth-modal");
  const openBtn = $("openAuthBtn");
  const closeBtn = $("closeAuthBtn");
  const signupBtn = $("signupBtn");
  const loginBtn = $("loginBtn");
  const logoutBtn = $("logoutBtn");
  const err = $("authError");

  if (!modal || !openBtn || !closeBtn || !signupBtn || !loginBtn || !logoutBtn) return;

  openBtn.onclick = () => {
    if (err) err.textContent = "";
    show(modal, true);
  };
  closeBtn.onclick = () => show(modal, false);

  signupBtn.onclick = async () => {
    if (err) err.textContent = "";
    const email = ($("email")?.value || "").trim();
    const password = $("password")?.value || "";
    if (!email || !password) {
      if (err) err.textContent = "Email and password required.";
      return;
    }
    try {
      await createUserWithEmailAndPassword(auth, email, password);
      show(modal, false);
    } catch (e) {
      if (err) err.textContent = e?.message || "Sign up failed.";
    }
  };

  loginBtn.onclick = async () => {
    if (err) err.textContent = "";
    const email = ($("email")?.value || "").trim();
    const password = $("password")?.value || "";
    if (!email || !password) {
      if (err) err.textContent = "Email and password required.";
      return;
    }
    try {
      await signInWithEmailAndPassword(auth, email, password);
      show(modal, false);
    } catch (e) {
      if (err) err.textContent = e?.message || "Login failed.";
    }
  };

  logoutBtn.onclick = async () => {
    await signOut(auth);
  };

  modal.addEventListener("click", (ev) => {
    if (ev.target === modal) show(modal, false);
  });
}

/* ===================== NAVIGATION ===================== */
window.showView = function (id) {
  const views = document.querySelectorAll(".view");
  for (const v of views) v.style.display = "none";

  const target = document.getElementById(id);
  if (target) target.style.display = "block";

  if (id === "view-scanner") {
    setTimeout(startScanner, 200);
  } else {
    stopScanner();
  }

  if (id === "view-library") {
    if (skipNextLibraryReload) {
      skipNextLibraryReload = false;
    } else if (!librarySyncInFlight) {
      loadLibrary();
  }
}

};

/* ===================== SCANNER ===================== */
async function loadQuagga() {
  if (window.Quagga) return;
  const s = document.createElement("script");
  s.src = Quagga_CDN;
  const p = new Promise((res, rej) => {
    s.onload = res;
    s.onerror = rej;
  });
  document.head.appendChild(s);
  await p;
}

function resetDetectionStability() {
  lastCode = null;
  sameCount = 0;
  lastAcceptTs = 0;
}

function isPlausibleIsbnBarcode(raw) {
  const cleaned = String(raw || "").replace(/[^0-9X]/gi, "");
  if (cleaned.length === 13) return cleaned.startsWith("978") || cleaned.startsWith("979");
  if (cleaned.length === 10) return true;
  return false;
}

window.startScanner = async function startScanner() {
  if (scannerActive) return;
  scannerActive = true;
  detectionLocked = false;
  resetDetectionStability();

  const box = document.getElementById("interactive");
  if (box) box.innerHTML = "";

  await loadQuagga();

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
  } catch {
    alert("Camera permission denied.");
    scannerActive = false;
    return;
  }

  // iOS/WebKit fix: lock body layout while camera runs
  document.body.style.position = "fixed";
  document.body.style.top = "0";
  document.body.style.left = "0";
  document.body.style.right = "0";

  Quagga.init(
    {
      inputStream: {
        type: "LiveStream",
        target: box,
        constraints: {
          facingMode: "environment",
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        area: { top: "25%", right: "10%", left: "10%", bottom: "25%" },
      },
      decoder: { readers: ["ean_reader"], multiple: false },
      locate: true,
      locator: { patchSize: "large", halfSample: false },
      numOfWorkers: navigator.hardwareConcurrency || 4,
      frequency: 10,
    },
    (err) => {
      if (err) {
        console.error("Quagga init error:", err);
        showToast("Scanner failed to start", "#dc3545");
        scannerActive = false;
        return;
      }
      Quagga.start();

      const v = box ? box.querySelector("video") : null;
      if (v) {
        v.setAttribute("playsinline", "true");
        v.setAttribute("webkit-playsinline", "true");
        v.play().catch(() => {});
      }
    }
  );

  if (Quagga.offDetected) Quagga.offDetected(onDetectedRaw);
  Quagga.onDetected(onDetectedRaw);
};

function stopScanner() {
  scannerActive = false;
  detectionLocked = false;
  resetDetectionStability();

  // release iOS/WebKit body lock
  document.body.style.position = "";
  document.body.style.top = "";
  document.body.style.left = "";
  document.body.style.right = "";

  try {
    if (window.Quagga) Quagga.stop();
  } catch {}

  if (mediaStream) {
    try {
      mediaStream.getTracks().forEach((t) => t.stop());
    } catch {}
    mediaStream = null;
  }

  const el = document.getElementById("interactive");
  if (el) el.innerHTML = "";
}

function onDetectedRaw(result) {
  if (detectionLocked) return;

  const raw = result && result.codeResult ? result.codeResult.code : null;
  if (!raw) return;
  if (!isPlausibleIsbnBarcode(raw)) return;

  if (raw === lastCode) sameCount += 1;
  else {
    lastCode = raw;
    sameCount = 1;
  }

  const now = Date.now();
  if (now - lastAcceptTs < 1200) return;

  if (sameCount >= 3) {
    lastAcceptTs = now;
    onDetected(result);
  }
}

async function onDetected(result) {
  if (detectionLocked) return;
  detectionLocked = true;

  stopScanner();

  try {
    if (navigator.vibrate) navigator.vibrate(80);
  } catch {}

  const raw = result && result.codeResult ? result.codeResult.code : "";
  handleISBN(raw);
}

/* ===================== BOOK LOOKUPS ===================== */
function normalizeIsbn(raw) {
  return String(raw || "").replace(/[^0-9X]/gi, "");
}

async function lookupGoogleBooks(isbn) {
  if (!GOOGLE_BOOKS_API_KEY) return null;

  const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&maxResults=1&key=${encodeURIComponent(
    GOOGLE_BOOKS_API_KEY
  )}`;

  const r = await fetch(url);
  const j = await r.json();

  if (!j.items || !j.items.length) return null;

  const i = j.items[0].volumeInfo || {};
  return {
    title: i.title || null,
    author: i.authors ? i.authors.join(", ") : null,
    image: i.imageLinks ? i.imageLinks.thumbnail : null,
    category: (i.categories && i.categories[0]) || null,
  };
}

async function lookupOpenLibrary(isbn) {
  const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data&exact=true`;
  const r = await fetch(url);
  const j = await r.json();

  const b = j[`ISBN:${isbn}`];
  if (!b) return null;

  const title = b.title || null;
  const author = b.authors ? b.authors.map((a) => a.name).join(", ") : null;

  let image = (b.cover && (b.cover.medium || b.cover.large || b.cover.small)) || null;
  if (image) image = image.replace("http://", "https://");
  const fallback = `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg`;

  let rawSubjects = [];
  if (Array.isArray(b.subjects) && b.subjects.length) {
    rawSubjects = b.subjects
      .map((s) => (typeof s === "string" ? s : s && s.name))
      .filter(Boolean);
  }

  try {
    const workKey = b.works && b.works[0] ? b.works[0].key : null;
    if (workKey) {
      const wr = await fetch(`https://openlibrary.org${workKey}.json`);
      const wj = await wr.json();
      if (Array.isArray(wj.subjects) && wj.subjects.length) rawSubjects = wj.subjects;
    }
  } catch {}

  const category = normaliseCategory(rawSubjects);
  return { title, author, image: image || fallback, category };
}

/* ===================== BOOK FLOW ===================== */
async function handleISBN(raw) {
  const isbn = normalizeIsbn(raw);

  if (!isValidISBN(isbn)) {
    showToast("Not a valid book ISBN", "#dc3545");
    showView("view-home");
    return;
  }

  showToast("Searching...", "#6c5ce7");

  try {
    let meta = await lookupOpenLibrary(isbn);
    if (!meta) meta = await lookupGoogleBooks(isbn);
    if (!meta) throw new Error("Not found");

    const title = meta.title || "Unknown";
    const author = meta.author || "Unknown";
    const image = String(meta.image || `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg`).replace("http://", "https://");
    const category = meta.category || "General & Other";

    const isRead = await askReadStatus(title);

    // Shared by default
    const book = { isbn, title, author, image, category };

    await upsertBookFamily(book, { read: !!isRead, visibility: "shared" });
    showView("view-library");
  } catch (e) {
    console.error("Lookup failed:", e);
    showToast("Book not found", "#dc3545");
    showView("view-home");
  }
}

/* ===================== FAMILY CRUD ===================== */
function bookIdFromIsbn(isbn) {
  return String(isbn || "").replace(/[^0-9X]/gi, "") || newId();
}

async function upsertBookFamily(book, userData) {
  if (!currentUser) return;
  if (!familyId) await ensureFamilyVault();

  const bookId = bookIdFromIsbn(book.isbn);

  // Write canonical shared family shelf
  await setDoc(bookMetaRef(familyId, bookId), {
    isbn: book.isbn || "",
    title: book.title || "Unknown",
    author: book.author || "Unknown",
    image: (book.image || "").replace("http://", "https://"),
    category: book.category || "General & Other",
    updatedAt: serverTimestamp()
  }, { merge: true });

  // Optional private copy
  if (userData.visibility === "private") {
    await setDoc(doc(privateShelfCol(familyId, currentUser.uid), bookId), { ...book }, { merge: true });
  } else {
    await deleteDoc(doc(privateShelfCol(familyId, currentUser.uid), bookId)).catch(()=>{});
  }

  // Per-user metadata
  await setDoc(userDataRef(familyId, bookId, currentUser.uid), {
    read: !!userData.read,
    updatedAt: serverTimestamp()
  }, { merge: true });

  await loadLibrary();
}

async function setVisibility(bookId, newVisibility) {
  const b = myLibrary.find((x) => x.bookId === bookId);
  if (!b) return;

  await upsertBookFamily(
    {
      isbn: b.isbn,
      title: b.title,
      author: b.author,
      image: b.image,
      category: b.category,
    },
    { read: !!b.read, visibility: newVisibility }
  );
}

async function toggleRead(bookId) {
  const b = myLibrary.find((x) => x.bookId === bookId);
  if (!b || !currentUser || !familyId) return;

  b.read = !b.read;
  saveLocalFallback(myLibrary);
  populateCategoryFilter();
  applyFilters();

  await setDoc(
    userDataRef(familyId, bookId, currentUser.uid),
    { read: !!b.read, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

async function deleteBook(bookId) {
  if (!confirm("Delete?")) return;
  if (!currentUser || !familyId) return;

  // Remove from shelves (shared + this user's private)
  await deleteDoc(doc(sharedShelfCol(familyId), bookId)).catch(() => {});
  await deleteDoc(doc(privateShelfCol(familyId, currentUser.uid), bookId)).catch(() => {});

  // Remove userData for this user
  await deleteDoc(userDataRef(familyId, bookId, currentUser.uid)).catch(() => {});

  myLibrary = myLibrary.filter((x) => x.bookId !== bookId);
  saveLocalFallback(myLibrary);
  populateCategoryFilter();
  applyFilters();
}

/* ===================== LOAD LIBRARY (shared + private) ===================== */
window.loadLibrary = async function loadLibrary() {
  librarySyncInFlight = true;
  showToast("Syncing...", "#17a2b8");

  try {
    if (!currentUser) {
      myLibrary = loadLocalFallback();
      populateCategoryFilter();
      applyFilters();
      showToast("Log in to sync", "#6c757d");
      return;
    }

    if (!familyId) await ensureFamilyVault();
    if (!familyId) throw new Error("family missing");

    // Load shared shelf + private shelf
    const [sharedSnap, privateSnap] = await Promise.all([
    getDocs(sharedShelfCol(familyId)),
    getDocs(privateShelfCol(familyId, currentUser.uid))
  ]);

  const privateIds = new Set(privateSnap.docs.map(d => d.id));

  const merged = sharedSnap.docs
    .filter(d => !privateIds.has(d.id))
    .map(d => ({ bookId: d.id, ...d.data(), visibility: "shared" }))
    .concat(
      privateSnap.docs.map(d => ({ bookId: d.id, ...d.data(), visibility: "private" }))
    );


    // Pull per-user read data for each book
    const withUserData = await Promise.all(
      merged.map(async (b) => {
        try {
          const ud = await getDoc(userDataRef(familyId, b.bookId, currentUser.uid));
          const read = ud.exists() ? !!ud.data()?.read : false;
          return { ...b, read };
        } catch {
          return { ...b, read: false };
        }
      })
    );

    withUserData.sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")));

    myLibrary = withUserData;

    saveLocalFallback(myLibrary);
    populateCategoryFilter();
    applyFilters();
    showToast("Sync OK", "#28a745");
  } catch (e) {
    console.error(e);
    showToast("Offline Mode", "#6c757d");
    myLibrary = loadLocalFallback();
    populateCategoryFilter();
    applyFilters();
  } finally {
    librarySyncInFlight = false;
  }
};

function setupCategorySuggestions(currentValue = "") {
  const input = document.getElementById("edit-category");
  const box = document.getElementById("category-suggestions");

  if (!input || !box) return;

  const categories = [
    ...new Set(myLibrary.map(b => b.category).filter(Boolean))
  ].sort();

  function render(filter = "") {
    box.innerHTML = "";

    categories
      .filter(c => c.toLowerCase().includes(filter.toLowerCase()))
      .slice(0, 8)
      .forEach(c => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = c;
        btn.onclick = () => {
          input.value = c;
          box.innerHTML = "";
        };
        box.appendChild(btn);
      });
  }

  input.oninput = () => render(input.value);

  // initial render
  render(currentValue);
}

/* ===================== UI ===================== */


let editingBookId = null;

window.openEditBook = function (bookId) {
  const book = myLibrary.find(b => b.bookId === bookId);
  if (!book) {
    console.error("Book not found", bookId);
    return;
  }

  editingBookId = bookId;

  const cover = document.getElementById("edit-cover");
  const title = document.getElementById("edit-title-input");
  const author = document.getElementById("edit-author-input");
  const category = document.getElementById("edit-category");
  const isbn = document.getElementById("edit-isbn");

  // 🔍 Debug safety (leave this in for now)
  console.log({ cover, title, author, category, isbn });

  if (!cover || !title || !author || !category || !isbn) {
    console.error("Edit view missing elements");
    return;
  }

  cover.src = book.image || "";
  title.value = book.title || "";
  author.value = book.author || "";
  category.value = book.category || "";
  isbn.value = book.isbn || "";

  setupCategorySuggestions(book.category || "");

  showView("view-edit-book");
};




function askReadStatus(title) {
  return new Promise((res) => {
    const m = $("read-modal");
    $("modal-title").textContent = title;
    m.style.display = "flex";

    $("btn-read-yes").onclick = () => {
      m.style.display = "none";
      res(true);
    };
    $("btn-read-no").onclick = () => {
      m.style.display = "none";
      res(false);
    };
  });
}

function renderLibrary(list) {
  if (!Array.isArray(list)) list = myLibrary;

  const ul = $("book-list");
  if (!ul) return;
  ul.innerHTML = "";

  list.forEach((b) => {
    const li = document.createElement("li");
    li.className = "book-item";

    const img = document.createElement("img");
    img.src = b.image;
    img.alt = b.title || "Book cover";
    img.loading = "lazy";
    img.onerror = () => {
      if (b.isbn) img.src = `https://covers.openlibrary.org/b/isbn/${b.isbn}-M.jpg`;
    };

    const info = document.createElement("div");
    info.className = "book-info";

    const title = document.createElement("strong");
    title.textContent = b.title || "Unknown title";

    const author = document.createElement("div");
    author.className = "book-author";
    author.textContent = b.author || "";

    const category = document.createElement("div");
    category.className = "book-category";
    category.textContent = (b.category || "Uncategorised");

    const badges = document.createElement("div");
    badges.className = "book-badges";

    /* ───────── Unified Chip System ───────── */

    // Read / Unread
    const readChip = document.createElement("span");
    readChip.className = `chip ${b.read ? "on" : "off"}`;
    readChip.textContent = b.read ? "READ" : "UNREAD";
    readChip.onclick = () => toggleRead(b.bookId);

    // Shared / Private
    const visChip = document.createElement("span");
    visChip.className = "chip";
    visChip.textContent = b.visibility === "private" ? "PRIVATE" : "SHARED";
    visChip.onclick = () =>
      setVisibility(b.bookId, b.visibility === "private" ? "shared" : "private");

    // Format (Print / E-book)
    const fmtChip = document.createElement("span");
    fmtChip.className = "chip subtle";
    fmtChip.textContent = b.format === "ebook" ? "E-BOOK" : "PRINT";

    // Delete (muted, calm, inline)
    const editChip = document.createElement("span");
    editChip.className = "chip subtle";
    editChip.textContent = "EDIT";
    editChip.onclick = () => openEditBook(b.bookId);

    badges.append(readChip, visChip, fmtChip, editChip);


    info.append(title, author, category, badges);
    li.append(img, info);
    ul.appendChild(li);
  });
}


/* ===================== UTIL ===================== */
function showToast(msg, color) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  t.style.background = color;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

function isValidISBN(isbn) {
  isbn = String(isbn || "");

  if (isbn.length === 10) {
    let sum = 0;
    for (let i = 0; i < 10; i++) {
      const c = isbn[i] === "X" ? 10 : parseInt(isbn[i], 10);
      if (Number.isNaN(c)) return false;
      sum += c * (10 - i);
    }
    return sum % 11 === 0;
  }

  if (isbn.length === 13) {
    if (!/^\d{13}$/.test(isbn)) return false;
    let sum = 0;
    for (let i = 0; i < 13; i++) {
      const n = parseInt(isbn[i], 10);
      sum += n * (i % 2 === 0 ? 1 : 3);
    }
    return sum % 10 === 0;
  }

  return false;
}

/* ===================== FILTERS ===================== */
window.applyFilters = function applyFilters() {
  const searchEl = $("searchBox");
  const readEl = $("filterRead");
  const catEl = $("filterCategory");
  const sortEl = $("sortBy");

  const q = searchEl ? (searchEl.value || "").toLowerCase() : "";
  const readFilter = readEl ? readEl.value : "all";
  const catFilter = catEl ? catEl.value : "all";
  const sort = sortEl ? sortEl.value : "title";

  let books = myLibrary.slice();

  if (q) {
    books = books.filter((b) => {
      return (
        (b.title || "").toLowerCase().includes(q) ||
        (b.author || "").toLowerCase().includes(q) ||
        (b.category || "").toLowerCase().includes(q) ||
        (b.isbn || "").includes(q)
      );
    });
  }

  if (readFilter === "read") books = books.filter((b) => !!b.read);
  if (readFilter === "unread") books = books.filter((b) => !b.read);

  if (catFilter !== "all") books = books.filter((b) => (b.category || "") === catFilter);

  books.sort((a, b) => String(a[sort] || "").localeCompare(String(b[sort] || "")));

  renderLibrary(books);
  updateHomeStats();
};

function updateHomeStats() {
  const total = myLibrary.length;
  const read = myLibrary.filter((b) => !!b.read).length;

  const sc = $("stat-count");
  const sr = $("stat-read");
  const su = $("stat-unread");

  if (sc) sc.textContent = total;
  if (sr) sr.textContent = read;
  if (su) su.textContent = total - read;
}

window.populateCategoryFilter = function populateCategoryFilter() {
  const select = $("filterCategory");
  if (!select) return;

  const current = select.value || "all";

  const cats = [...new Set(myLibrary.map(b => b.category).filter(Boolean))].sort();

  select.innerHTML =
    `<option value="all">All categories</option>` +
    cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");

  select.value = cats.includes(current) ? current : "all";
};


function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[m]));
}

/* ===================== CATEGORY NORMALISATION ===================== */
function normaliseCategory(subjects = []) {
  const s = subjects.map((x) => String(x || "").toLowerCase());

  if (s.some((x) => /mystery|detective|crime|thriller|suspense|private investigator|missing persons|murder/.test(x)))
    return "Mystery & Thriller";
  if (s.some((x) => /fantasy|quests|elder wand|mutants/.test(x))) return "Fantasy";
  if (s.some((x) => /science fiction|sci-fi|alien/.test(x))) return "Science Fiction";
  if (s.some((x) => /mythology/.test(x))) return "Mythology";
  if (s.some((x) => /history|historical|roman|romans|england|great britain|asia/.test(x)))
    return "History & Historical Fiction";
  if (s.some((x) => /literary|english literature|american literature|classic|fiction/.test(x)))
    return "Literary Fiction";
  if (s.some((x) => /romance|love poetry|mothers and daughters/.test(x))) return "Romance & Relationships";
  if (s.some((x) => /biography|authors|autobiography|biographical fiction/.test(x))) return "Biography & Memoir";
  if (s.some((x) => /psychology|social|abuse|famil|brothers|society/.test(x))) return "Psychology & Society";
  if (s.some((x) => /business|economics|leadership|management|corporation|strategy/.test(x)))
    return "Business & Economics";
  if (s.some((x) => /self-help|critical thinking|contentment|life change|quality of work life/.test(x)))
    return "Self-Help & Mindfulness";
  if (s.some((x) => /children|juvenile|young adult|school/.test(x))) return "Children & Young Adult";
  if (s.some((x) => /poetry|poems/.test(x))) return "Poetry";
  if (s.some((x) => /religion|hindu|jewish/.test(x))) return "Religion & Spirituality";
  if (s.some((x) => /technology|engineering|science/.test(x))) return "Technology & Science";
  if (s.some((x) => /comic|graphic|astérix|tintin|art|music|humou?r|puzzle/.test(x))) return "Comics, Art & Humor";
  if (s.some((x) => /travel/.test(x))) return "Travel & Adventure";
  if (s.some((x) => /language|grammar|translation|education|school/.test(x))) return "Education & Language";
  if (s.some((x) => /short stories/.test(x))) return "Short Stories";

  return "General & Other";
}

/* ===================== LOCAL FALLBACK ===================== */
function saveLocalFallback(lib) {
  try {
    localStorage.setItem("bn_local_library", JSON.stringify(lib || []));
  } catch {}
}
function loadLocalFallback() {
  try {
    const saved = localStorage.getItem("bn_local_library");
    if (!saved) return [];
    const arr = JSON.parse(saved) || [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/* ===================== MANUAL ISBN ===================== */
const manualBtn = $("manual-btn");
if (manualBtn) {
  manualBtn.onclick = () => {
    const isbn = prompt("Enter ISBN:");
    if (isbn) handleISBN(isbn.trim());
  };
}

$("saveEditBtn").onclick = async () => {
  if (!editingBookId || !familyId) return;

  const newTitle = $("edit-title-input")?.value.trim() || "Unknown";
  const newAuthor = $("edit-author-input")?.value.trim() || "Unknown";
  const newCategory = $("edit-category")?.value.trim() || "General & Other";

  // 1️⃣ Save to Firestore
  await setDoc(
    doc(db, "families", familyId, "books", editingBookId),
    {
      title: newTitle,
      author: newAuthor,
      category: newCategory,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  // 2️⃣ Update local library state
  const book = myLibrary.find(b => b.bookId === editingBookId);
  if (book) {
    book.title = newTitle;
    book.author = newAuthor;
    book.category = newCategory;
  }

  // 3️⃣ Refresh UI
  saveLocalFallback(myLibrary);
  populateCategoryFilter();
  applyFilters();

  // 4️⃣ Go back to library
  skipNextLibraryReload = true;
  showView("view-library");
};


$("deleteEditBtn").onclick = async () => {
  if (!editingBookId) return;
  if (!confirm("Delete this book permanently?")) return;

  await deleteBook(editingBookId);
  showView("view-library");
};

/* ===================== INIT ===================== */
window.copyInviteLink = function copyInviteLink() {
  if (!familyId) {
    showToast("Family not ready yet", "#dc3545");
    return;
  }

  const link = `${location.origin}${location.pathname}?join=${familyId}`;
  navigator.clipboard.writeText(link).then(() => {
    showToast("Invite link copied!", "#28a745");
  }).catch(() => {
    alert("Copy failed. Long-press this link:\n\n" + link);
  });
};

function bindLibraryControls() {
  const search = $("searchBox");
  const read = $("filterRead");
  const cat = $("filterCategory");
  const sort = $("sortBy");
  const sync = $("syncBtn");

  if (search) search.oninput = applyFilters;
  if (read) read.onchange = applyFilters;
  if (cat) cat.onchange = applyFilters;
  if (sort) sort.onchange = applyFilters;
  if (sync) sync.onclick = loadLibrary;
}


window.onload = () => {
  bindAuthModal();
  bindLibraryControls();


  // render instantly (offline fallback)
  myLibrary = loadLocalFallback();
  populateCategoryFilter();
  applyFilters();

  // start on home
  showView("view-home");

  

};

window.db = db;
window.doc = doc;
window.setDoc = setDoc;
window.serverTimestamp = serverTimestamp;
