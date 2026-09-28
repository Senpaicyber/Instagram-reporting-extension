// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
// Posts/reels and profiles go through different report flows on Instagram --
// profiles have two extra screens ("Report profile" and "It's posting
// content that shouldn't be on Instagram") before landing on the same
// "Selling or promoting restricted items" -> "Tobacco" categories.
const POST_REPORT_FLOW_STEPS = [
  "Report",
  "Selling or promoting restricted items",
  "Tobacco",
];

const PROFILE_REPORT_FLOW_STEPS = [
  "Report",
  "Report profile",
  "It's posting content that shouldn't be on Instagram",
  "Selling or promoting restricted items",
  "Tobacco",
];

// Story highlights (instagram.com/stories/highlights/<id>) open the story
// viewer, whose "..." is labeled "Menu". A highlight is a tray of several
// stories, so the flow is repeated on each one (clicking "Next") until the
// tray ends. Same category path as a post; edit here if IG shows extra screens.
const HIGHLIGHT_REPORT_FLOW_STEPS = [
  "Report",
  "Selling or promoting restricted items",
  "Tobacco",
];

const TAB_URL_PATTERNS = [
  "*://www.instagram.com/p/*",
  "*://www.instagram.com/reel/*",
  "*://instagram.com/p/*",
  "*://instagram.com/reel/*",
  "*://www.instagram.com/stories/highlights/*",
  "*://instagram.com/stories/highlights/*",
];

// Matches a real IG post/reel permalink, OR a bare profile URL
// (instagram.com/<username>) -- the same "..." -> Report -> category flow
// works from a profile page too (reporting the account directly), and that
// was previously being rejected outright since it doesn't have a /p/ or
// /reel/ segment. IG_RESERVED_PATHS excludes single-segment system paths
// (explore, accounts, direct, etc.) that would otherwise look like a
// profile username to the plain regex.
const IG_POST_RE = /^https?:\/\/(www\.)?instagram\.com\/(p|reel)\/[A-Za-z0-9_-]+\/?(?:[?#].*)?$/i;
// "stories" is in IG_RESERVED_PATHS (so /stories/... never looks like a
// username), which is why highlight links used to be rejected as invalid.
const IG_HIGHLIGHT_RE = /^https?:\/\/(www\.)?instagram\.com\/stories\/highlights\/\d+\/?(?:[?#].*)?$/i;
const IG_PROFILE_RE = /^https?:\/\/(www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:[?#].*)?$/i;
const IG_RESERVED_PATHS = new Set([
  "p", "reel", "reels", "explore", "accounts", "direct", "direct_v2",
  "stories", "tv", "developer", "about", "legal", "privacy", "terms",
  "challenge", "emails", "help", "web", "tags", "download",
]);

function isValidIgLink(url) {
  if (IG_POST_RE.test(url)) return true;
  if (IG_HIGHLIGHT_RE.test(url)) return true;
  const m = url.match(IG_PROFILE_RE);
  if (m && !IG_RESERVED_PATHS.has(m[2].toLowerCase())) return true;
  return false;
}

// Decides which report-flow step list applies to a given (already-validated)
// URL. Checked against the tab's actual resolved URL right before running
// the flow, so it works the same whether the link was pasted or came from an
// already-open tab.
function isHighlightLink(url) {
  return IG_HIGHLIGHT_RE.test(url || "");
}

function isProfileLink(url) {
  if (IG_POST_RE.test(url)) return false;
  if (IG_HIGHLIGHT_RE.test(url)) return false;
  const m = url.match(IG_PROFILE_RE);
  return !!(m && !IG_RESERVED_PATHS.has(m[2].toLowerCase()));
}

const CLOSE_TAB_AFTER_PROCESSING = true; // frees RAM/CPU by not leaving IG tabs open

// Each queue item is either:
//   { type: "tab",  tab: <already-open Tab object> }
//   { type: "link", url: <string, not yet opened> }
// Link items are only turned into an actual open tab right before they're
// processed, inside runLoop -- so tabs open one at a time, get reported,
// then close (or stay open if unconfirmed), before the next one opens.
let queue = [];
let currentIndex = -1;
let running = false;
let stopRequested = false;
const results = [];

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const linksInput = document.getElementById("linksInput");
const tabInfo = document.getElementById("tabInfo");
const countdown = document.getElementById("countdown");
const progress = document.getElementById("progress");
const logBox = document.getElementById("log");
const skippedSection = document.getElementById("skippedSection");
const skippedBox = document.getElementById("skippedBox");
const copySkippedBtn = document.getElementById("copySkippedBtn");
const unavailableSection = document.getElementById("unavailableSection");
const unavailableBox = document.getElementById("unavailableBox");
const copyUnavailableBtn = document.getElementById("copyUnavailableBtn");

const initParams = new URLSearchParams(window.location.search);
if (initParams.has("detached")) {
  progress.textContent = "Ready. Safe to switch to other tabs while this runs.";
  const linksParam = initParams.get("links");
  if (linksParam) {
    try {
      linksInput.value = decodeURIComponent(linksParam);
    } catch (e) {
      // ignore malformed param, just leave the box empty
    }
  }
}

startBtn.addEventListener("click", startAutoRun);
stopBtn.addEventListener("click", () => {
  stopRequested = true;
  progress.textContent = "Stopping after current tab…";
});
copySkippedBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(skippedBox.value);
    copySkippedBtn.textContent = "Copied!";
    copySkippedBtn.classList.add("copied");
    setTimeout(() => {
      copySkippedBtn.textContent = "Copy skipped links";
      copySkippedBtn.classList.remove("copied");
    }, 1500);
  } catch (e) {
    // Fallback: select the text so the user can Ctrl/Cmd+C manually.
    skippedBox.focus();
    skippedBox.select();
  }
});
copyUnavailableBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(unavailableBox.value);
    copyUnavailableBtn.textContent = "Copied!";
    copyUnavailableBtn.classList.add("copied");
    setTimeout(() => {
      copyUnavailableBtn.textContent = "Copy links";
      copyUnavailableBtn.classList.remove("copied");
    }, 1500);
  } catch (e) {
    unavailableBox.focus();
    unavailableBox.select();
  }
});

// ---------------------------------------------------------------------------
// Link parsing
// ---------------------------------------------------------------------------
function parseLinkLines(raw) {
  return raw
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Splits pasted lines into valid IG post/reel URLs vs. everything else.
// Does NOT open any tabs -- that happens lazily, one at a time, in runLoop.
function splitValidLinks(raw) {
  const lines = parseLinkLines(raw);
  const validLinks = [];
  const invalidLinks = [];
  for (const url of lines) {
    if (isValidIgLink(url)) validLinks.push(url);
    else invalidLinks.push(url);
  }
  return { validLinks, invalidLinks };
}

function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") finish();
    }
    chrome.tabs.onUpdated.addListener(listener);
    // In case it already finished loading before we attached the listener.
    chrome.tabs.get(tabId).then((t) => {
      if (t && t.status === "complete") finish();
    }).catch(finish);
  });
}

// ---------------------------------------------------------------------------
// Run control
// ---------------------------------------------------------------------------
async function startAutoRun() {
  // Chrome auto-closes the action popup the instant it loses focus (e.g.
  // you click a tab). Since a full run can take minutes, pop the UI out
  // into its own standalone window on first click so it survives that.
  // Whatever is currently typed into the links box is carried over via a
  // URL param so it's still there once the detached window opens.
  if (!initParams.has("detached")) {
    const rawLinks = linksInput.value.trim();
    const detachedUrl = new URL(chrome.runtime.getURL("popup.html"));
    detachedUrl.searchParams.set("detached", "1");
    if (rawLinks) detachedUrl.searchParams.set("links", encodeURIComponent(rawLinks));

    chrome.windows.create({
      url: detachedUrl.toString(),
      type: "popup",
      width: 420,
      height: 660,
    });
    window.close();
    return;
  }

  startBtn.disabled = true;
  linksInput.disabled = true;
  skippedSection.style.display = "none";
  skippedBox.value = "";
  unavailableSection.style.display = "none";
  unavailableBox.value = "";
  results.length = 0;
  logBox.innerHTML = "";

  const rawLinks = linksInput.value.trim();

  if (rawLinks) {
    const { validLinks, invalidLinks } = splitValidLinks(rawLinks);

    // Invalid lines never get opened at all -- log + skip them immediately.
    for (const url of invalidLinks) {
      const fakeTab = { id: null, url, title: url };
      logResult(fakeTab, { success: false, stepLabel: "validate link", message: "invalid link — never opened" });
    }

    if (!validLinks.length) {
      progress.textContent = invalidLinks.length
        ? `No valid Instagram post/reel/profile/highlight links found (${invalidLinks.length} skipped as invalid).`
        : "No valid Instagram post/reel/profile/highlight links found.";
      startBtn.disabled = false;
      linksInput.disabled = false;
      showSkipped(results.filter((r) => r.url));
      return;
    }

    queue = validLinks.map((url) => ({ type: "link", url }));
  } else {
    const tabs = await chrome.tabs.query({ url: TAB_URL_PATTERNS });
    if (!tabs.length) {
      progress.textContent = "No open Instagram post/reel/highlight tabs found, and no links were entered.";
      startBtn.disabled = false;
      linksInput.disabled = false;
      return;
    }
    queue = tabs.map((tab) => ({ type: "tab", tab }));
  }

  currentIndex = 0;
  running = true;
  stopRequested = false;

  startBtn.style.display = "none";
  stopBtn.style.display = "block";
  tabInfo.style.display = "block";

  await runLoop();
}

async function runLoop() {
  while (currentIndex < queue.length && !stopRequested) {
    const item = queue[currentIndex];
    let tab;

    if (item.type === "link") {
      // Open THIS link now (not before) -- one tab open at a time.
      tabInfo.textContent = `Tab ${currentIndex + 1} of ${queue.length}: opening ${item.url}`;
      progress.textContent = "Opening link…";
      try {
        const created = await chrome.tabs.create({ url: item.url, active: true });
        await waitForTabComplete(created.id);
        tab = await chrome.tabs.get(created.id);
      } catch (e) {
        logResult({ id: null, url: item.url, title: item.url }, {
          success: false,
          stepLabel: "open tab",
          message: `Could not open tab: ${e.message}`,
        });
        currentIndex += 1;
        continue;
      }
    } else {
      tab = item.tab;
    }

    tabInfo.textContent = `Tab ${currentIndex + 1} of ${queue.length}: ${tab.title || tab.url}`;
    progress.textContent = "Running report flow…";

    await chrome.tabs.update(tab.id, { active: true });
    const win = await chrome.windows.get(tab.windowId);
    if (!win.focused) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }

    // The 5s wait for a submission confirmation (inside runOnTab) also
    // serves as the required tab-switch gap -- no separate delay needed
    // after this, we close and move straight to the next tab/link.
    const res = await runOnTab(tab);
    logResult(tab, res);

    // Only close the tab when we actually saw a confirmation on screen.
    // Anything else (flow failed, or it finished but no confirmation text
    // was detected) is left open so it can be checked/retried manually --
    // this applies whether the tab was already open or one we just opened
    // from a pasted link.
    const shouldClose = CLOSE_TAB_AFTER_PROCESSING && res.success && res.confirmed === true;
    if (shouldClose) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch (e) {
        // tab may have already been closed manually -- safe to ignore
      }
    }

    currentIndex += 1;
  }

  finishRun();
}

async function runOnTab(tab) {
  const mode = isHighlightLink(tab.url) ? "highlight" : isProfileLink(tab.url) ? "profile" : "post";
  const steps =
    mode === "highlight" ? HIGHLIGHT_REPORT_FLOW_STEPS :
    mode === "profile" ? PROFILE_REPORT_FLOW_STEPS :
    POST_REPORT_FLOW_STEPS;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: runReportFlowInPage,
      args: [steps, mode],
    });
    return result;
  } catch (e) {
    return { success: false, stepLabel: "injection", message: e.message };
  }
}

function logResult(tab, res) {
  results.push({
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
    success: res.success,
    confirmed: res.confirmed,
    notFound: !!res.notFound,
    message: res.message,
  });
  const line = document.createElement("div");
  const label = tab.title || tab.url;
  let cls, icon, detail;
  if (res.notFound) {
    cls = "log-warn";
    icon = "■";
    detail = `content not available — ${res.message}`;
  } else if (!res.success) {
    cls = "log-fail";
    icon = "✗";
    detail = res.stepLabel === "validate link" ? res.message : `failed at "${res.stepLabel || "?"}" — left open — ${res.message}`;
  } else if (res.confirmed === false) {
    cls = "log-warn";
    icon = "△";
    detail = `unconfirmed — left open — ${res.message}`;
  } else {
    cls = "log-ok";
    icon = "✓";
    detail = res.message;
  }
  line.className = "log-line " + cls;
  line.textContent = `${icon} ${label}: ${detail}`;
  logBox.prepend(line);
}

function sleepPopup(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function showUnavailable(items) {
  if (!items.length) {
    unavailableSection.style.display = "none";
    return;
  }
  unavailableBox.value = items.map((i) => i.url).join("\n");
  unavailableSection.style.display = "block";
}

function showSkipped(items) {
  // items: results-shaped objects with a .url
  if (!items.length) {
    skippedSection.style.display = "none";
    return;
  }
  skippedBox.value = items.map((i) => i.url).join("\n");
  skippedSection.style.display = "block";
}

function finishRun() {
  running = false;
  startBtn.disabled = false;
  linksInput.disabled = false;
  stopBtn.style.display = "none";
  startBtn.style.display = "block";
  startBtn.textContent = "Run again";
  tabInfo.style.display = "none";
  countdown.style.display = "none";

  const confirmed = results.filter((r) => r.success && r.confirmed === true).length;
  // Content-not-available results are pulled into their own copyable list,
  // separate from the general "left open" bucket that still covers
  // everything else (failed steps, unconfirmed) exactly as before.
  const unavailable = results.filter((r) => r.notFound);
  const skipped = results.filter((r) => !r.notFound && !(r.success && r.confirmed === true));
  progress.textContent = stopRequested
    ? `Stopped. ${confirmed} confirmed & closed, ${unavailable.length} content not available, ${skipped.length} left open before stopping.`
    : `Done. ${confirmed} confirmed & closed, ${unavailable.length} content not available, ${skipped.length} left open out of ${results.length}.`;

  showUnavailable(unavailable.filter((r) => r.url));
  showSkipped(skipped.filter((r) => r.url));
}

// ---------------------------------------------------------------------------
// Injected into each Instagram tab. Must be fully self-contained (no
// references to outer scope) since chrome.scripting serializes it.
// ---------------------------------------------------------------------------
function runReportFlowInPage(steps, mode) {
  const isHighlight = mode === "highlight";
  const startPath = location.pathname; // if this changes we've left the highlight (e.g. IG jumped to another one)

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  // ---- Enhanced "..." (More options) detection -----------------------
  // Tries progressively looser strategies, scoped to the most likely
  // container first (an open dialog/modal, then the post <article>, then
  // <main>) so we don't accidentally grab a "more options" button that
  // belongs to a different post on the page (e.g. a sidebar suggestion).

  function findPostContainer() {
    const dialog = document.querySelector('div[role="dialog"]');
    if (dialog && isVisible(dialog)) return dialog;
    const article = document.querySelector("article");
    if (article) return article;
    const main = document.querySelector("main");
    if (main) return main;
    return document.body;
  }

  // Matches both "More options" (used on individual posts) and the bare
  // "Options" label Instagram uses on the profile page's own menu trigger --
  // that difference is why the "..." next to a username wasn't being found
  // even though the identical-looking button on a post worked fine.
  const MORE_LABEL_RE = /\boptions\b/i;

  function svgLooksLikeDots(svg) {
    if (!svg) return false;
    // Classic ellipsis glyph: three <circle> elements.
    if (svg.querySelectorAll("circle").length === 3) return true;
    const title = svg.querySelector("title");
    if (title && MORE_LABEL_RE.test(title.textContent || "")) return true;
    return false;
  }

  // Some Instagram surfaces render the "..." as plain ellipsis characters
  // instead of an svg glyph -- catches "...", "···", "‥", "…" and similar,
  // as long as there's nothing else in the button's text.
  function looksLikeEllipsisGlyph(text) {
    const t = (text || "").trim();
    if (!t) return false;
    return /^[.\u2022\u00b7\u2025\u2026\s]{1,6}$/.test(t);
  }

  const CLICKABLE_SEL = 'button, [role="button"], div[tabindex]';

  function findMoreOptionsButton() {
    const scope = findPostContainer();
    const scopes = scope === document.body ? [document] : [scope, document];

    // Tier 1: svg[aria-label] matching "options" (covers "More options" on
    // posts and the bare "Options" label on the profile page).
    for (const s of scopes) {
      const svgs = s.querySelectorAll("svg[aria-label]");
      for (const svg of svgs) {
        if (MORE_LABEL_RE.test(svg.getAttribute("aria-label") || "")) {
          const btn = svg.closest(CLICKABLE_SEL);
          if (btn && isVisible(btn)) return btn;
        }
      }
    }

    // Tier 2: aria-label on the clickable element itself
    for (const s of scopes) {
      const labeled = s.querySelectorAll("[aria-label]");
      for (const el of labeled) {
        if (MORE_LABEL_RE.test(el.getAttribute("aria-label") || "")) {
          const btn = el.closest(CLICKABLE_SEL) || el;
          if (isVisible(btn)) return btn;
        }
      }
    }

    // Tier 3: <svg><title>...</title></svg> pattern
    for (const s of scopes) {
      const svgs = s.querySelectorAll("svg");
      for (const svg of svgs) {
        const title = svg.querySelector("title");
        if (title && MORE_LABEL_RE.test(title.textContent || "")) {
          const btn = svg.closest(CLICKABLE_SEL);
          if (btn && isVisible(btn)) return btn;
        }
      }
    }

    // Tier 4: glyph-based -- a small, roughly-square icon-only button whose
    // svg is built from three dots/circles, OR whose own text content is
    // just ellipsis-style characters with no icon at all.
    {
      const candidates = scope.querySelectorAll(CLICKABLE_SEL);
      for (const btn of candidates) {
        if (!isVisible(btn)) continue;
        const rect = btn.getBoundingClientRect();
        if (rect.width < 12 || rect.width > 56 || rect.height < 12 || rect.height > 56) continue;
        if (Math.abs(rect.width - rect.height) > 12) continue; // roughly square
        const text = (btn.textContent || "").trim();
        const ellipsisText = looksLikeEllipsisGlyph(text);
        if (!ellipsisText && text.length > 2) continue; // icon-only, no visible label text
        const innerSvg = btn.querySelector("svg");
        if (ellipsisText || svgLooksLikeDots(innerSvg)) return btn;
      }
    }

    // Tier 5: near-username -- on the profile page the "..." sits directly
    // beside the username heading rather than in a conventional toolbar.
    // Walk forward a few siblings from the h1/h2 holding the username (and,
    // if that wrapper turns out to hold only the heading itself, from its
    // parent too) and grab the first small icon-only/ellipsis-text
    // clickable found.
    {
      const heading = scope.querySelector("h1, h2");
      const tryFrom = (startEl) => {
        let sib = startEl ? startEl.nextElementSibling : null;
        let hops = 0;
        while (sib && hops < 4) {
          if (isVisible(sib)) {
            const rect = sib.getBoundingClientRect();
            const text = (sib.textContent || "").trim();
            if (rect.width > 0 && rect.width < 60 && rect.height < 60 && (text.length <= 2 || looksLikeEllipsisGlyph(text))) {
              const btn = sib.matches(CLICKABLE_SEL) ? sib : sib.querySelector(CLICKABLE_SEL);
              if (btn && isVisible(btn)) return btn;
            }
          }
          sib = sib.nextElementSibling;
          hops++;
        }
        return null;
      };
      if (heading) {
        const direct = tryFrom(heading);
        if (direct) return direct;
        const viaParent = tryFrom(heading.parentElement);
        if (viaParent) return viaParent;
      }
    }

    // Tier 6: last resort -- the rightmost empty-text (or ellipsis-text)
    // icon button in the post/profile header row.
    {
      const header = scope.querySelector("header") || scope;
      const headerButtons = Array.from(header.querySelectorAll(CLICKABLE_SEL)).filter((b) => {
        if (!isVisible(b)) return false;
        const t = (b.textContent || "").trim();
        return t.length === 0 || looksLikeEllipsisGlyph(t);
      });
      if (headerButtons.length) {
        headerButtons.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
        return headerButtons[0];
      }
    }

    return null;
  }
  // ----------------------------------------------------------------------

  // ---- Story-highlight helpers ---------------------------------------
  // In the story viewer the "..." is an svg labeled "Menu" (not "Options").
  function findStoryMenuButton() {
    for (const el of document.querySelectorAll("[aria-label]")) {
      if (!/^\s*menu\s*$/i.test(el.getAttribute("aria-label") || "")) continue;
      const btn = el.closest(CLICKABLE_SEL) || el;
      if (isVisible(btn)) return btn;
    }
    return findMoreOptionsButton(); // fallback to the generic tiers
  }

  function findNextButton() {
    for (const el of document.querySelectorAll('[aria-label="Next"]')) {
      const btn = el.closest(CLICKABLE_SEL) || el;
      if (isVisible(btn)) return btn;
    }
    return null;
  }

  // The viewer's media (biggest visible video/img) -- used both to tell
  // stories apart and to know where the story card is on screen.
  function storyMedia() {
    let best = null, area = 0;
    for (const el of document.querySelectorAll("video, img")) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 200) continue;
      if (r.width * r.height > area) { area = r.width * r.height; best = el; }
    }
    return best;
  }

  // Identifies the story currently on screen (media src + timestamp).
  function storyFingerprint() {
    const parts = [];
    for (const v of document.querySelectorAll("video")) {
      if (isVisible(v)) parts.push("v:" + (v.currentSrc || v.src || ""));
    }
    for (const im of document.querySelectorAll("img")) {
      if (!isVisible(im)) continue;
      const r = im.getBoundingClientRect();
      if (r.width >= 200 && r.height >= 200) parts.push("i:" + (im.currentSrc || im.src || ""));
    }
    const t = document.querySelector("time");
    if (t) parts.push("t:" + (t.getAttribute("datetime") || t.textContent || ""));
    return parts.join("|");
  }

  // Progress bar at the top of the viewer = a row of thin bars, one per
  // story. Returns 0 if it can't be found. Only used to flag early stops.
  function storySegmentCount() {
    try {
      let best = 0;
      for (const c of document.querySelectorAll("div")) {
        const kids = c.children;
        if (kids.length < 2 || kids.length > 100) continue;
        let ok = true, top = null;
        for (const k of kids) {
          const r = k.getBoundingClientRect();
          if (r.height === 0 || r.height > 8 || r.width < 4 || r.top > 200) { ok = false; break; }
          if (top === null) top = r.top;
          else if (Math.abs(r.top - top) > 2) { ok = false; break; }
        }
        if (ok && kids.length > best) best = kids.length;
      }
      return best;
    } catch (e) {
      return 0;
    }
  }

  function pressKey(key, keyCode) {
    const target = document.activeElement || document.body;
    for (const type of ["keydown", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true }));
    }
  }

  function fireClickAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return;
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
    }
  }

  async function waitForStoryChange(before, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(200);
      if (location.pathname !== startPath) return "left";
      if (storyFingerprint() !== before) return "changed";
    }
    return "same";
  }

  // Moves to the next story. Tries the Next arrow first, then the
  // ArrowRight key, then a tap on the right side of the story card, and
  // verifies each attempt by checking the story on screen actually changed
  // (so a slow load never causes a second advance / skipped story).
  // Returns "changed" | "assumed" | "left" | "same" (same = couldn't advance).
  async function advanceStory(fpBefore) {
    if (fpBefore && storyFingerprint() !== fpBefore) return "changed"; // already moved on its own
    const next = findNextButton();

    if (!fpBefore) {
      // Can't fingerprint stories on this page: fall back to trusting the Next arrow.
      if (!next) return "same";
      next.click();
      await sleep(1200);
      return location.pathname === startPath ? "assumed" : "left";
    }

    const attempts = [];
    if (next) attempts.push(() => next.click());
    attempts.push(() => pressKey("ArrowRight", 39));
    attempts.push(() => {
      const m = storyMedia();
      if (!m) return;
      const r = m.getBoundingClientRect();
      fireClickAt(r.left + r.width * 0.85, r.top + r.height * 0.5);
    });

    for (const act of attempts) {
      act();
      const res = await waitForStoryChange(fpBefore, 2500);
      if (res !== "same") return res;
    }
    return "same";
  }

  // After "Done" the report dialog normally closes on its own. If one is
  // still up, close it via its own X. Only the innermost dialog that looks
  // like the report dialog is touched (never one holding the story media),
  // so the story viewer itself is never closed by mistake.
  async function dismissReportDialog() {
    await sleep(500);
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]')).filter(isVisible);
    for (const d of dialogs) {
      if (dialogs.some((o) => o !== d && d.contains(o))) continue; // want innermost
      if (d.querySelector("video")) continue;
      const big = Array.from(d.querySelectorAll("img")).some((im) => {
        const r = im.getBoundingClientRect();
        return r.width >= 200 && r.height >= 200;
      });
      if (big) continue;
      const txt = (d.innerText || "").toLowerCase();
      if (!/\breport\b|letting us know|\bdone\b/.test(txt)) continue;
      const closeEl = d.querySelector('[aria-label="Close"]');
      if (closeEl) {
        (closeEl.closest(CLICKABLE_SEL) || closeEl).click();
        await sleep(400);
        return;
      }
    }
  }

  function findClickableByText(text) {
    const target = text.trim().toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    const candidates = [];
    let node;
    while ((node = walker.nextNode())) {
      const content = (node.textContent || "").trim().toLowerCase();
      if (!content) continue;
      if (content === target || (content.includes(target) && content.length <= target.length + 25)) {
        candidates.push(node);
      }
    }
    candidates.sort((a, b) => a.textContent.length - b.textContent.length);
    for (const el of candidates) {
      const clickable = el.closest('button, [role="button"], a, div[tabindex]') || el;
      if (isVisible(clickable)) return clickable;
    }
    return null;
  }

  function findConfirmationSignal() {
    // Instagram typically shows a "Done" button and/or a confirmation
    // toast/screen after a report is submitted (exact wording varies by
    // flow/locale). A visible "Done" button is treated as confirmation on
    // its own, same as the phrase checks below.
    const doneBtn = findClickableByText("Done");
    if (doneBtn) return true;

    const phrases = [
      "thanks for reporting",
      "thank you for reporting",
      "we've received your report",
      "we have received your report",
      "your report has been submitted",
      "thanks for letting us know",
      "thank you for letting us know",
    ];
    const bodyText = (document.body.innerText || "").toLowerCase();
    return phrases.some((p) => bodyText.includes(p));
  }

  async function waitFixedThenCheckConfirmation(waitMs) {
    // Always wait the full duration before returning -- no early exit even
    // if a confirmation shows up sooner. This guarantees at least `waitMs`
    // passes before the tab is closed.
    await sleep(waitMs);
    return findConfirmationSignal();
  }

  // Used only for the middle stories of a highlight: returns as soon as a
  // confirmation shows up (max timeoutMs) so long trays don't take 5s each.
  async function waitForConfirmation(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (findConfirmationSignal()) return true;
      await sleep(250);
    }
    return false;
  }

  async function waitFor(findFn, timeoutMs = 4000, intervalMs = 200) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = findFn();
      if (el) return el;
      await sleep(intervalMs);
    }
    return null;
  }

  function pageLooksUnavailable() {
    // Instagram's "This content isn't available at the moment" screen
    // (owner restricted who can see it, or it's been deleted) -- tracked
    // as its own distinct outcome rather than lumped in with a step that
    // simply couldn't be found.
    const bodyText = (document.body.innerText || "").toLowerCase();
    const signals = [
      "this content isn't available",
      "this content isnt available",
      "content isn't available right now",
      "sorry, this page isn't available",
      "the link you followed may be broken",
      "page not found",
      "user not found",
      "sorry, this page isn't available.",
    ];
    return signals.some((s) => bodyText.includes(s));
  }

  // One full menu -> steps -> confirmation pass against whatever is
  // currently showing. Used once for posts/reels/profiles, and once per
  // story for highlights.
  async function reportOnce() {
    const menuBtn = await waitFor(isHighlight ? findStoryMenuButton : findMoreOptionsButton, 4000);
    if (!menuBtn) {
      return { ok: false, stepLabel: "Open menu (...)", message: "Could not find the post's '...' menu button on this page." };
    }
    menuBtn.click();
    await sleep(700);

    for (let i = 0; i < steps.length; i++) {
      const stepText = steps[i];
      const el = await waitFor(() => findClickableByText(stepText), 4000);
      if (!el) {
        return { ok: false, stepLabel: stepText, message: `Could not find "${stepText}" on screen after 4 seconds.` };
      }
      el.click();
      await sleep(i === 0 ? 900 : 700);
    }

    // Fixed 5s wait before a tab is closed (doubles as the tab-switch gap).
    // Middle stories of a highlight poll with early exit instead.
    const lastItem = !isHighlight || !findNextButton();
    const confirmed = lastItem
      ? await waitFixedThenCheckConfirmation(5000)
      : await waitForConfirmation(5000);

    if (confirmed) {
      try {
        const doneBtn = findClickableByText("Done");
        if (doneBtn) doneBtn.click();
      } catch (e) {}
    }
    return { ok: true, confirmed };
  }

  const UNAVAILABLE_MSG = "Content isn't available -- owner restricted who can see it, or it's been deleted/removed.";

  return (async () => {
    if (pageLooksUnavailable()) {
      return { success: false, notFound: true, stepLabel: "page check", message: UNAVAILABLE_MSG };
    }

    // ---- Posts / reels / profiles: single pass ----
    if (!isHighlight) {
      const r = await reportOnce();
      if (!r.ok) {
        const nowUnavailable = r.stepLabel === "Open menu (...)" && pageLooksUnavailable();
        return {
          success: false,
          notFound: nowUnavailable,
          stepLabel: r.stepLabel,
          message: nowUnavailable ? UNAVAILABLE_MSG : r.message,
        };
      }
      return {
        success: true,
        confirmed: r.confirmed,
        message: r.confirmed
          ? `Report submitted -- confirmation detected on screen.`
          : `Report flow completed (${steps.length} steps); no confirmation text detected after 5s wait -- closing anyway.`,
      };
    }

    // ---- Story highlight: report every story in the tray ----
    // Best-effort: some story links show a "View story" gate first.
    await sleep(1500);
    const gate = findClickableByText("View story") || findClickableByText("View highlight");
    if (gate) {
      gate.click();
      await sleep(1200);
    }

    const MAX_STORIES = 60; // safety cap so a stuck viewer can't loop forever
    const total = storySegmentCount(); // 0 = couldn't tell
    const seen = new Set();
    let reported = 0;
    let confirmedCount = 0;
    let stopReason = "";
    for (let n = 1; n <= MAX_STORIES; n++) {
      const fpBefore = storyFingerprint();
      if (fpBefore && seen.has(fpBefore)) {
        stopReason = "same story came up again after advancing";
        break;
      }

      const r = await reportOnce();
      if (!r.ok) {
        const unavailable = n === 1 && r.stepLabel === "Open menu (...)" && pageLooksUnavailable();
        return {
          success: false,
          notFound: unavailable,
          stepLabel: `story ${n}: ${r.stepLabel}`,
          message: unavailable
            ? UNAVAILABLE_MSG
            : `Story ${n}: ${r.message}${reported ? ` (${reported} earlier stories were already reported)` : ""}`,
        };
      }
      if (fpBefore) seen.add(fpBefore);
      reported++;
      if (r.confirmed) confirmedCount++;

      await dismissReportDialog();

      const adv = await advanceStory(fpBefore);
      if (adv === "left") { stopReason = "viewer closed"; break; }
      if (adv === "same") { stopReason = "couldn't advance (no Next arrow / key / tap worked)"; break; }
      await sleep(400); // let the next story settle
    }

    const noun = reported === 1 ? "story" : "stories";
    const incomplete = total > reported; // progress bar showed more stories than we reported
    const allConfirmed = reported > 0 && confirmedCount === reported && !incomplete;
    let message = `Highlight: ${reported}${total ? ` of ${total}` : ""} ${noun} reported`;
    if (incomplete) message += ` -- STOPPED EARLY (${stopReason || "unknown"})`;
    else if (confirmedCount < reported) message += `, only ${confirmedCount} confirmed`;
    else message += " -- all confirmed";
    if (!allConfirmed) message += " -- leaving open";
    return { success: true, confirmed: allConfirmed, message };
  })();
}
