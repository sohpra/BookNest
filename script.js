/* ===================== CONFIG ===================== */
/* USERS */
const USERS = ["sohini", "som", "rehan"];

const params = new URLSearchParams(location.search);
let CURRENT_USER = (params.get("user") || "").toLowerCase().trim();

// HARD GUARANTEE A USER
if (!USERS.includes(CURRENT_USER)) CURRENT_USER = (localStorage.getItem("bw_user") || "").toLowerCase().trim();
if (!USERS.includes(CURRENT_USER)) CURRENT_USER = "sohini";

localStorage.setItem("bw_user", CURRENT_USER);

/* ENDPOINTS */
const GOOGLE_SHEET_URL =
  "https://script.google.com/macros/s/AKfycbw1oZV1HEO21oadgp6IKkq9XR4v-2fwuinuKnAr_U1SyFYIrWqcNIpy6gux44pzgBAa_g/exec";
const Quagga_CDN =
  "https://cdn.jsdelivr.net/npm/@ericblade/quagga2/dist/quagga.min.js";

// Leave as "" to skip Google Books and use OpenLibrary only.
const GOOGLE_BOOKS_API_KEY = "YOUR_KEY";

/* STATE */
let myLibrary = [];
let scannerActive = false;
let detectionLocked = false;
let mediaStream = null;

let lastCode = null;
let sameCount = 0;
let lastAcceptTs = 0;

let librarySyncInFlight = false;

/* ===================== HELPERS (READ BY USER) ===================== */
function emptyReadBy() {
  return { sohini: false, som: false, rehan: false };
}

function ensureReadBy(book) {
  if (!book || typeof book !== "object") return emptyReadBy();
  if (!book.readBy || typeof book.readBy !== "object") book.readBy = emptyReadBy();
  for (const u of USERS) {
    if (typeof book.readBy[u] !== "boolean") book.readBy[u] = false;
  }
  return book.readBy;
}

function myReadStatus(book) {
  ensureReadBy(book);
  return !!book.readBy[CURRENT_USER];
}

function parseYesNo(v) {
  if (typeof v === "boolean") return v;
  const s = String(v || "").trim().toLowerCase();
  if (s === "yes" || s === "true" || s === "1") return true;
  return false;
}

/* ===================== NAVIGATION ===================== */
function showView(id) {
  const views = document.querySelectorAll(".view");
  for (const v of views) v.style.display = "none";

  const target = document.getElementById(id);
  if (target) target.style.display = "block";

  if (id === "view-scanner") {
    setTimeout(startScanner, 200);
  } else {
    stopScanner();
  }

  // Auto sync when opening library (helps iPhone/Safari where localStorage may be empty)
  if (id === "view-library") {
    // don’t spam requests
    if (!librarySyncInFlight) loadLibrary();
  }
}

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

async function startScanner() {
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
      locator: {
        patchSize: "large",
        halfSample: false,
      },
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
}

function stopScanner() {
  scannerActive = false;
  detectionLocked = false;
  resetDetectionStability();

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
  if (!GOOGLE_BOOKS_API_KEY || GOOGLE_BOOKS_API_KEY === "YOUR_KEY") return null;

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

  // Better: fetch work subjects (usually richer)
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

    const book = { isbn, title, author, image, category, readBy: emptyReadBy() };
    book.readBy[CURRENT_USER] = !!isRead;

    // preserve existing other-user statuses if this isbn already exists locally
    const existing = myLibrary.find((b) => b.isbn === isbn);
    if (existing) {
      ensureReadBy(existing);
      book.readBy = { ...existing.readBy, ...book.readBy };
      book.readBy[CURRENT_USER] = !!isRead;
    }

    // upsert
    myLibrary = myLibrary.filter((b) => b.isbn !== isbn);
    myLibrary.push(book);

    saveLibrary();
    populateCategoryFilter();
    applyFilters();

    cloudSync("add", book);
    showView("view-library");
  } catch (e) {
    console.error("Lookup failed:", e);
    showToast("Book not found", "#dc3545");
    showView("view-home");
  }
}

/* ===================== CLOUD ===================== */
async function loadLibrary() {
  librarySyncInFlight = true;
  showToast("Syncing...", "#17a2b8");

  try {
    const res = await fetch(GOOGLE_SHEET_URL, { cache: "no-store" });
    const data = await res.json();

    if (!Array.isArray(data)) throw new Error("Bad data");

    myLibrary = data.map((b) => {
      const isbn = String(b.isbn || "").trim();
      const img =
        String(b.image || "").replace("http://", "https://") ||
        (isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg` : "");

      // SUPPORT BOTH SHAPES:
      // 1) flat columns: read_sohini/read_som/read_rehan = "YES"/"NO"
      // 2) nested object: readBy: { sohini: true, ... }
      const readBy = emptyReadBy();

      // nested readBy
      if (b.readBy && typeof b.readBy === "object") {
        for (const u of USERS) readBy[u] = !!b.readBy[u];
      }

      // flat columns override/augment if present
      for (const u of USERS) {
        const k = `read_${u}`;
        if (k in b) readBy[u] = parseYesNo(b[k]);
      }

      return {
        isbn,
        title: b.title || "Unknown",
        author: b.author || "Unknown",
        image: img,
        category: b.category || "General & Other",
        readBy,
      };
    });

    saveLibrary();
    populateCategoryFilter();
    applyFilters();
    showToast("Sync OK", "#28a745");
  } catch (e) {
    console.error(e);
    showToast("Offline Mode", "#6c757d");
    populateCategoryFilter();
    applyFilters();
  } finally {
    librarySyncInFlight = false;
  }
}

function cloudSync(action, book) {
  const payload = { action, user: CURRENT_USER, data: book };

  fetch(GOOGLE_SHEET_URL, {
    method: "POST",
    body: JSON.stringify(payload),
  }).catch(() => {});
}

/* ===================== UI ===================== */
function askReadStatus(title) {
  return new Promise((res) => {
    const m = document.getElementById("read-modal");
    document.getElementById("modal-title").textContent = title;
    m.style.display = "flex";

    document.getElementById("btn-read-yes").onclick = () => {
      m.style.display = "none";
      res(true);
    };
    document.getElementById("btn-read-no").onclick = () => {
      m.style.display = "none";
      res(false);
    };
  });
}

function renderLibrary(list) {
  if (!Array.isArray(list)) list = myLibrary;

  const ul = document.getElementById("book-list");
  if (!ul) return;
  ul.innerHTML = "";

  list.forEach((b) => {
    ensureReadBy(b);
    const mine = myReadStatus(b);

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
    flag.className = `status-flag ${mine ? "read" : "unread"}`;
    flag.textContent = mine ? "✅ Read" : "📖 Unread";
    flag.onclick = () => toggleRead(b.isbn);

    const del = document.createElement("button");
    del.className = "delete-btn";
    del.textContent = "🗑️";
    del.onclick = () => deleteBook(b.isbn);

    info.append(title, author, category, flag);
    li.append(img, info, del);
    ul.appendChild(li);
  });
}

function toggleRead(isbn) {
  const b = myLibrary.find((x) => x.isbn === isbn);
  if (!b) return;

  ensureReadBy(b);
  b.readBy[CURRENT_USER] = !b.readBy[CURRENT_USER];

  saveLibrary();
  populateCategoryFilter();
  applyFilters();

  cloudSync("update", b);
}

function deleteBook(isbn) {
  if (!confirm("Delete?")) return;
  const b = myLibrary.find((x) => x.isbn === isbn);

  myLibrary = myLibrary.filter((x) => x.isbn !== isbn);
  saveLibrary();
  populateCategoryFilter();
  applyFilters();

  if (b) cloudSync("delete", b);
  else cloudSync("delete", { isbn });
}

/* ===================== UTIL ===================== */
function saveLibrary() {
  localStorage.setItem("myLibrary", JSON.stringify(myLibrary));
}

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
function applyFilters() {
  const searchEl = document.getElementById("searchBox");
  const readEl = document.getElementById("filterRead");
  const catEl = document.getElementById("filterCategory");
  const sortEl = document.getElementById("sortBy");

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

  if (readFilter === "read") books = books.filter((b) => !!(b.readBy && b.readBy[CURRENT_USER]));
  if (readFilter === "unread") books = books.filter((b) => !(b.readBy && b.readBy[CURRENT_USER]));

  if (catFilter !== "all") books = books.filter((b) => (b.category || "") === catFilter);

  books.sort((a, b) => (String(a[sort] || "")).localeCompare(String(b[sort] || "")));

  renderLibrary(books);
  updateHomeStats();
}

function updateHomeStats() {
  const total = myLibrary.length;
  const read = myLibrary.filter((b) => b.readBy && b.readBy[CURRENT_USER]).length;

  const sc = document.getElementById("stat-count");
  const sr = document.getElementById("stat-read");
  const su = document.getElementById("stat-unread");

  if (sc) sc.textContent = total;
  if (sr) sr.textContent = read;
  if (su) su.textContent = total - read;
}

function populateCategoryFilter() {
  const select = document.getElementById("filterCategory");
  if (!select) return;

  const cats = [...new Set(myLibrary.map((b) => b.category).filter(Boolean))].sort();
  select.innerHTML =
    `<option value="all">All categories</option>` +
    cats.map((c) => `<option value="${c}">${c}</option>`).join("");
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

/* ===================== MANUAL ISBN ===================== */
const manualBtn = document.getElementById("manual-btn");
if (manualBtn) {
  manualBtn.onclick = () => {
    const isbn = prompt("Enter ISBN:");
    if (isbn) handleISBN(isbn.trim());
  };
}

/* ===================== INIT ===================== */
window.onload = () => {
  const saved = localStorage.getItem("myLibrary");
  if (saved) {
    try {
      myLibrary = JSON.parse(saved) || [];
      myLibrary = myLibrary.map((b) => {
        // legacy isRead -> assume it was sohini
        if (!b.readBy && Object.prototype.hasOwnProperty.call(b, "isRead")) {
          b.readBy = emptyReadBy();
          b.readBy.sohini = !!b.isRead;
        }
        ensureReadBy(b);
        return b;
      });
    } catch {
      myLibrary = [];
    }
  }

  populateCategoryFilter();
  applyFilters();
  showView("view-home");
};
