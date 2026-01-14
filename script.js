/* ===================== BOOKNEST (FAMILY MODE v1) ===================== */
/* Keeps: Auth UI, Scanner (Quagga), Lookups, Filters, UI flow
   Changes: Data model => families/{familyId}/...
   - Shared shelf default
   - Private shelf per user
   - Per-user read stored in userData subcollection
   - Auto-creates a family vault on first login ("Our BookNest")
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

/* ===================== CONFIG ===================== */
const Quagga_CDN = "https://cdn.jsdelivr.net/npm/@ericblade/quagga2/dist/quagga.min.js";
// Leave as "" to skip Google Books and use OpenLibrary only.
const GOOGLE_BOOKS_API_KEY = ""; // optional

/* ===================== STATE ===================== */
let currentUser = null; // Firebase user
let familyId = null;    // current family vault id
let myLibrary = [];     // merged: shared + private (with per-user read)
let scannerActive = false;
let detectionLocked = false;
let mediaStream = null;

let lastCode = null;
let sameCount = 0;
let lastAcceptTs = 0;

let librarySyncInFlight = false;

/* ===================== DOM HELPERS ===================== */
const $ = (id) => document.getElementById(id);
function show(el, yes) {
  if (el) el.style.display = yes ? "" : "none";
}

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
  return collection(db, "families", fid, "shelves", "shared", "books");
}
function privateShelfCol(fid, uid) {
  return collection(db, "families", fid, "shelves", `private_${uid}`, "books");
}

// Per-book metadata canonical (optional, but good future-proofing)
function bookMetaRef(fid, bookId) {
  return doc(db, "families", fid, "books", bookId);
}

// Per-user data for a book (read, rating, notes, tags etc)
function userDataRef(fid, bookId, uid) {
  return doc(db, "families", fid, "books", bookId, "userData", uid);
}

/* ===================== FAMILY BOOTSTRAP ===================== */
function newId() {
  // crypto.randomUUID is supported in modern browsers; fallback if needed
  return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2));
}

async function ensureFamilyVault() {
  if (!currentUser) return null;

  const idx = await getDoc(userIndexRef(currentUser.uid));
  if (idx.exists() && idx.data()?.familyId) {
    familyId = idx.data().familyId;
    return familyId;
  }

  // Create a new family vault for this parent (v1 behaviour)
  familyId = newId();

  await setDoc(familyRef(familyId), {
    name: "Our BookNest",
    createdBy: currentUser.uid,
    createdAt: serverTimestamp(),
  });

  await setDoc(memberRef(familyId, currentUser.uid), {
    name: currentUser.email || "Parent",
    role: "parent",
    joinedAt: serverTimestamp(),
  });

  await setDoc(userIndexRef(currentUser.uid), {
    familyId,
    updatedAt: serverTimestamp(),
  });

  return familyId;
}

/* ===================== AUTH UI ===================== */
function setAuthUI() {
  const status = $("authStatus");
  const logoutBtn = $("logoutBtn");
  const openAuthBtn = $("openAuthBtn");
  const loginHint = $("loginHint");

  if (!status || !openAuthBtn || !logoutBtn) return;

  if (currentUser) {
    status.textContent = `Logged in as ${currentUser.email}`;
    show(logoutBtn, true);
    openAuthBtn.textContent = "Account";
    show(loginHint, false);
  } else {
    status.textContent = "Not logged in";
    show(logoutBtn, false);
    openAuthBtn.textContent = "Log in";
    show(loginHint, true);
  }
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
    if (!librarySyncInFlight) loadLibrary();
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
      decoder: {
        readers: ["ean_reader"],
        multiple: false,
      },
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
    const book = {
      isbn,
      title,
      author,
      image,
      category,
    };

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
  if (!currentUser) {
    showToast("Log in to save books", "#6c757d");
    show($("auth-modal"), true);
    return;
  }

  if (!familyId) await ensureFamilyVault();
  if (!familyId) {
    showToast("Family not ready", "#dc3545");
    return;
  }

  const bookId = bookIdFromIsbn(book.isbn);

  // 1) Save canonical metadata (future proof)
  await setDoc(
    bookMetaRef(familyId, bookId),
    {
      isbn: book.isbn || "",
      title: book.title || "Unknown",
      author: book.author || "Unknown",
      image: (book.image || "").replace("http://", "https://"),
      category: book.category || "General & Other",
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    },
    { merge: true }
  );

  // 2) Write to shelf (denormalised so lists are fast)
  const visibility = (userData?.visibility || "shared");
  if (visibility === "private") {
    // remove from shared, add to private
    await deleteDoc(doc(sharedShelfCol(familyId), bookId)).catch(() => {});
    await setDoc(
      doc(privateShelfCol(familyId, currentUser.uid), bookId),
      {
        ...book,
        isbn: book.isbn || "",
        image: (book.image || "").replace("http://", "https://"),
        category: book.category || "General & Other",
        visibility: "private",
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } else {
    // remove from private, add to shared
    await deleteDoc(doc(privateShelfCol(familyId, currentUser.uid), bookId)).catch(() => {});
    await setDoc(
      doc(sharedShelfCol(familyId), bookId),
      {
        ...book,
        isbn: book.isbn || "",
        image: (book.image || "").replace("http://", "https://"),
        category: book.category || "General & Other",
        visibility: "shared",
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  }

  // 3) Per-user data (read/rating/notes/tags later)
  await setDoc(
    userDataRef(familyId, bookId, currentUser.uid),
    {
      read: !!userData?.read,
      rating: userData?.rating ?? null,
      notes: userData?.notes ?? "",
      tags: Array.isArray(userData?.tags) ? userData.tags : [],
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

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

  // Remove from both shelves (shared + this user's private)
  await deleteDoc(doc(sharedShelfCol(familyId), bookId)).catch(() => {});
  await deleteDoc(doc(privateShelfCol(familyId, currentUser.uid), bookId)).catch(() => {});

  // Remove userData (for this user)
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

    // Load shared shelf + private shelf
    const [sharedSnap, privateSnap] = await Promise.all([
      getDocs(sharedShelfCol(familyId)),
      getDocs(privateShelfCol(familyId, currentUser.uid)),
    ]);

    const sharedBooks = sharedSnap.docs.map((d) => ({ bookId: d.id, ...d.data(), visibility: "shared" }));
    const privateBooks = privateSnap.docs.map((d) => ({ bookId: d.id, ...d.data(), visibility: "private" }));

    // Merge (private wins if same id exists)
    const map = new Map();
    for (const b of sharedBooks) map.set(b.bookId, b);
    for (const b of privateBooks) map.set(b.bookId, b);
    const merged = Array.from(map.values());

    // Pull per-user read data for each book
    const readDocs = await Promise.all(
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

    // Stable sort: title
    readDocs.sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")));

    myLibrary = readDocs;

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

/* ===================== UI ===================== */
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
    author.style.fontSize = ".85rem";
    author.style.opacity = ".7";
    author.textContent = b.author || "";

    const category = document.createElement("div");
    category.style.fontSize = ".7rem";
    category.style.opacity = ".55";
    category.textContent = "📚 " + (b.category || "Uncategorised");

    const flag = document.createElement("span");
    flag.className = `status-flag ${b.read ? "read" : "unread"}`;
    flag.textContent = b.read ? "✅ Read" : "📖 Unread";
    flag.onclick = () => toggleRead(b.bookId);

    // NEW: visibility toggle
    const vis = document.createElement("span");
    vis.className = "status-flag";
    vis.style.marginLeft = "10px";
    vis.style.opacity = ".9";
    vis.textContent = b.visibility === "private" ? "🔒 Private" : "👪 Shared";
    vis.onclick = () => setVisibility(b.bookId, b.visibility === "private" ? "shared" : "private");

    const del = document.createElement("button");
    del.className = "delete-btn";
    del.textContent = "🗑️";
    del.onclick = () => deleteBook(b.bookId);

    info.append(title, author, category, flag, vis);
    li.append(img, info, del);
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

  const cats = [...new Set(myLibrary.map((b) => b.category).filter(Boolean))].sort();
  select.innerHTML =
    `<option value="all">All categories</option>` +
    cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
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

/* ===================== INIT ===================== */
window.onload = () => {
  bindAuthModal();

  // render instantly (offline fallback)
  myLibrary = loadLocalFallback();
  populateCategoryFilter();
  applyFilters();

  // start on home
  showView("view-home");

  onAuthStateChanged(auth, async (user) => {
    currentUser = user || null;
    setAuthUI();

    if (currentUser) {
      await ensureFamilyVault();
      await loadLibrary();
    } else {
      familyId = null;
      myLibrary = loadLocalFallback();
      populateCategoryFilter();
      applyFilters();
    }
  });
};
