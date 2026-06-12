// ==UserScript==
// @name         STV Chinese Learning Companion
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  Learn Chinese while reading: density-budgeted kept phrases, SRS rotation, pinyin/Hán-Việt/audio tooltips, Anki export
// @author       You
// @match        https://sangtacviet.com/truyen/*/*
// @match        https://sangtacviet.vip/truyen/*/*
// @match        https://sangtacviet.vn/truyen/*/*
// @require      https://cdn.jsdelivr.net/npm/pinyin@4.0.0/lib/umd/pinyin.min.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // =====================================================================
    // iOS storage diagnostics (captured at script start, before anything
    // touches storage). Two independent probes:
    //   1. PERSIST PROBE — a counter on a key the SITE never touches. If it
    //      increments across reloads, our localStorage writes survive at all
    //      (not sandboxed by Stay). If it stays 0/blank, our writes never
    //      reach the page's storage → storage approach is impossible.
    //   2. CLOBBER PROBE — the count of $X=X entries the story key held when
    //      we arrived this load, i.e. what the SITE preserved from our last
    //      write. If our last-write count > this, the site clobbered us.
    // =====================================================================
    const DBG = { persistPrev: null, persistOK: null, storyKeyAtStart: null, selfCountAtStart: null, selfCountAfterWrite: null, lastWriteCount: null, syncSkipped: null, errors: [] };
    try {
        const raw = localStorage.getItem('STV_PERSIST_PROBE');
        DBG.persistPrev = raw === null ? null : parseInt(raw, 10);
        DBG.persistOK = (raw !== null && !isNaN(DBG.persistPrev));
        const next = (DBG.persistOK ? DBG.persistPrev : 0) + 1;
        localStorage.setItem('STV_PERSIST_PROBE', String(next));
    } catch (e) { /* storage unavailable */ }

    /**
     * Surface a caught failure to the user. There is no console on iOS, so
     * every error goes to a toast AND the panel's debug row — a silent
     * failure here looks like "the button does nothing".
     */
    function reportError(context, e) {
        const detail = e && e.name ? `${e.name}: ${e.message || ''}` : String(e);
        const msg = `${context} — ${detail}`;
        DBG.errors.push(msg);
        if (DBG.errors.length > 5) DBG.errors.shift();
        console.error('STV-Learn:', context, e);
        try { showNotification(msg, 'error'); } catch (e2) { /* no DOM yet */ }
        try { if (panelEl) updateDebugRow(); } catch (e2) { /* panel not built */ }
    }

    // =====================================================================
    // Learning DB
    //
    // Master vocabulary store, independent of the site's per-story name
    // storages. The story storage is treated as a render target: when the
    // user presses "Áp dụng", a budgeted subset of phrases (present in the
    // current chapter) is materialized into it as $X=X entries. The site
    // then renders that subset on the next page load — names take effect
    // on chapter load, which is the site's native behavior. Writes are
    // user-triggered only; automatic writes raced the site's late content
    // load on mobile.
    //
    // Shape:
    // {
    //   version: 1,
    //   settings: { budget: 15, disabledStories: [] },
    //   phrases: {
    //     "修炼": { added: "2026-06-11", status: "learning"|"known",
    //               exposures: 0, lapses: 0, lastSeen: "2026-06-11"|null,
    //               hv: "tu luyện", meaning: "" }
    //   }
    // }
    // hv (Hán-Việt reading) is harvested from the site's <i h="..."> the
    // first time a phrase is seen. The legacy `meaning` field is unused —
    // meanings now come from CC-CEDICT (IndexedDB), since the site's v
    // attribute is unreliable vietphrase MT.
    // =====================================================================

    const DB_KEY = 'STV_LEARN_DB';
    const GLOBAL_KEY = 'CHINESE_CHARACTERS';
    const DEFAULT_BUDGET = 15;
    // Exposures counted at most this many times per phrase per chapter,
    // so one chapter spamming a phrase doesn't fake mastery.
    const MAX_EXPOSURES_PER_CHAPTER = 3;
    // Suggest promoting to "known" at this exposure count (manual confirm).
    const PROMOTE_SUGGEST_AT = 30;

    function todayStr() {
        return new Date().toISOString().slice(0, 10);
    }

    function loadDB() {
        try {
            const raw = localStorage.getItem(DB_KEY);
            if (raw) {
                const db = JSON.parse(raw);
                if (db && db.phrases) {
                    db.settings = db.settings || {};
                    if (typeof db.settings.budget !== 'number') db.settings.budget = DEFAULT_BUDGET;
                    if (typeof db.settings.showKnown !== 'boolean') db.settings.showKnown = true;
                    if (!Array.isArray(db.settings.disabledStories)) db.settings.disabledStories = [];
                    return db;
                }
            }
        } catch (e) {
            console.error('STV-Learn: failed to parse DB, starting fresh', e);
        }
        return {
            version: 1,
            settings: { budget: DEFAULT_BUDGET, showKnown: true, disabledStories: [] },
            phrases: {}
        };
    }

    /**
     * Persist the learning DB. Returns false (after telling the user) when
     * the write fails — typically QuotaExceededError on iOS.
     */
    function saveDB(db) {
        try {
            localStorage.setItem(DB_KEY, JSON.stringify(db));
            return true;
        } catch (e) {
            reportError('LƯU DB THẤT BẠI (thay đổi sẽ mất khi tải lại)', e);
            return false;
        }
    }

    function dbAddPhrase(db, phrase) {
        phrase = phrase.trim();
        if (!phrase || db.phrases[phrase]) return false;
        db.phrases[phrase] = {
            added: todayStr(),
            status: 'learning',
            exposures: 0,
            lapses: 0,
            lastSeen: null,
            hv: '',
            meaning: ''
        };
        return true;
    }

    /**
     * Parse a site storage value ("$X=Y~//~...") into entries.
     * Returns [{ raw, left, right, isSelf }]
     */
    function parseStorageEntries(value) {
        return (value || '')
            .split('~//~')
            .filter(e => e.trim())
            .map(raw => {
                const m = raw.match(/^\$(.+)=(.+)$/);
                if (!m) return { raw, left: null, right: null, isSelf: false };
                const left = m[1].trim();
                const right = m[2].trim();
                return { raw, left, right, isSelf: left === right };
            });
    }

    /**
     * Single-character names break the machine translation badly (是, 了
     * etc. are everywhere and wreck whole sentences), so they are never
     * materialized into story storage. They stay in the DB for Anki export
     * and for Scan's known-character set.
     */
    function isMaterializable(phrase) {
        return [...phrase].length >= 2;
    }

    /**
     * Pick the phrases that should render as Chinese this session:
     * all "known" phrases (they cost no mental budget) plus up to
     * `budget` "learning" phrases, prioritized SRS-style:
     * never-seen first, then least-recently-seen day, then fewest exposures.
     * Day-granular lastSeen means the active set rotates between chapters
     * within a session — that churn is intentional spaced exposure.
     * Single-character phrases are excluded (see isMaterializable).
     */
    // SRS ordering: never-seen first, then least-recently-seen, then fewest
    // exposures. Used to prioritize which learning phrases fill the budget.
    function srsCompare(db) {
        return (a, b) => {
            const ia = db.phrases[a], ib = db.phrases[b];
            const seenA = ia.lastSeen || '';
            const seenB = ib.lastSeen || '';
            if (seenA !== seenB) return seenA < seenB ? -1 : 1; // '' (never) first
            if (ia.exposures !== ib.exposures) return ia.exposures - ib.exposures;
            // Among equally-unseen phrases, most recently ADDED first — a
            // phrase added today (manual/scan) should surface now, not queue
            // behind thousands of never-seen backlog imports.
            const addA = ia.added || '', addB = ib.added || '';
            if (addA !== addB) return addA > addB ? -1 : 1;
            return 0;
        };
    }

    function selectActivePhrases(db) {
        const known = [];
        const learning = [];
        let singles = 0;
        Object.entries(db.phrases).forEach(([phrase, info]) => {
            if (!isMaterializable(phrase)) { singles++; return; }
            if (info.status === 'known') known.push(phrase);
            else learning.push(phrase);
        });

        learning.sort(srsCompare(db));

        return {
            known,
            learningActive: learning.slice(0, db.settings.budget),
            learningTotal: learning.length,
            singles
        };
    }

    /**
     * Reconstruct this chapter's raw Chinese text from the rendered DOM:
     * each <i t> contributes its original Chinese (t), text nodes and <br>
     * are preserved so phrase boundaries are real. Used to detect which
     * collected phrases actually occur in the chapter.
     */
    function reconstructChapterText() {
        const boxes = document.querySelectorAll('.contentbox');
        const roots = boxes.length ? [...boxes] : [];
        if (!roots.length) return '';
        let out = '';
        const walk = node => {
            node.childNodes.forEach(n => {
                if (n.nodeType === Node.TEXT_NODE) {
                    out += n.textContent;
                } else if (n.nodeType === Node.ELEMENT_NODE) {
                    if (n.tagName === 'I' && n.hasAttribute('t')) out += n.getAttribute('t');
                    else if (n.tagName === 'BR') out += '\n';
                    else walk(n);
                }
            });
        };
        roots.forEach(walk);
        return out;
    }

    /**
     * Like selectActivePhrases, but restricted to phrases that actually
     * appear in this chapter's text — so budget slots aren't wasted on
     * phrases absent from the chapter. Returns the full active list
     * (known + budgeted learning) plus diagnostics.
     */
    function selectActiveForChapter(db, text) {
        const known = [];
        const learning = [];
        Object.entries(db.phrases).forEach(([phrase, info]) => {
            if (!isMaterializable(phrase)) return;
            if (!text.includes(phrase)) return; // present in this chapter only
            if (info.status === 'known') known.push(phrase);
            else learning.push(phrase);
        });
        learning.sort(srsCompare(db));
        const learningActive = learning.slice(0, db.settings.budget);
        const active = [
            ...(db.settings.showKnown ? known : []),
            ...learningActive
        ];
        return {
            active,
            knownPresent: known.length,
            learningActive: learningActive.length,
            learningPresent: learning.length,
            knownList: known,
            learningList: learning // SRS-ordered, present in this chapter
        };
    }

    // =====================================================================
    // MANUAL apply via the site's own name mechanism (localStorage).
    //
    // The user presses "Áp dụng" in the panel: we pick this chapter's
    // active $X=X set (budgeted SRS, presence-filtered) and write it to
    // story storage; the SITE renders the keeps when it reads storage on
    // the next load. Nothing writes story storage automatically anymore —
    // on mobile the chapter content loads late and an automatic write
    // raced the site's read, clobbering manual additions.
    // =====================================================================

    // Panel diagnostics for the current chapter.
    let chapterLearningActive = null;   // learning phrases saved in storage + present
    let chapterLearningPresent = null;  // learning phrases present in the text
    let chapterRenderedLearning = null; // learning phrases actually shown (DOM read)

    /**
     * Materialize an active phrase list into the story's storage:
     *  - real translation names ($X=Y, X≠Y) are kept untouched
     *  - single-char $X=X the user added to THIS story stay (story-local)
     *  - $X=X entries are written for the active set (unless an explicit
     *    translation already exists for that phrase)
     */
    function writeActiveToStorage(storyKey, activeList) {
        const active = new Set(activeList);
        const entries = parseStorageEntries(localStorage.getItem(storyKey));
        const keep = entries.filter(e =>
            !e.isSelf || (e.left && !isMaterializable(e.left))
        );
        const explicitLefts = new Set(keep.map(e => e.left).filter(Boolean));
        const selfEntries = [...active]
            .filter(p => !explicitLefts.has(p))
            .map(p => ({ raw: `$${p}=${p}`, left: p }));
        const all = [...keep, ...selfEntries];
        all.sort((a, b) => {
            const la = a.left ? a.left.length : a.raw.length;
            const lb = b.left ? b.left.length : b.raw.length;
            return la - lb;
        });
        try {
            localStorage.setItem(storyKey, all.length ? all.map(e => e.raw).join('~//~') + '~//~' : '');
        } catch (e) {
            reportError('Ghi kho truyện thất bại', e);
        }
    }

    /**
     * Append one $X=X entry to story storage right away (explicit user
     * add — allowed to exceed the budget). The phrase shows after the
     * next reload without needing an "Áp dụng" pass.
     */
    function appendSelfEntryToStory(phrase) {
        const storyKey = getLocalStorageKeyFromURL();
        if (!storyKey) return;
        try {
            const entries = parseStorageEntries(localStorage.getItem(storyKey));
            if (entries.some(en => en.left === phrase)) return;
            entries.push({ raw: `$${phrase}=${phrase}`, left: phrase });
            entries.sort((a, b) => {
                const la = a.left ? a.left.length : a.raw.length;
                const lb = b.left ? b.left.length : b.raw.length;
                return la - lb;
            });
            localStorage.setItem(storyKey, entries.map(en => en.raw).join('~//~') + '~//~');
        } catch (e) {
            reportError('Ghi kho truyện thất bại', e);
        }
    }

    /**
     * document-start: record what the story key held when we arrived
     * (debug only — no writes happen automatically anymore).
     */
    function recordStorageProbe() {
        const storyKey = getLocalStorageKeyFromURL();
        if (!storyKey) return;
        DBG.storyKeyAtStart = storyKey;
        DBG.selfCountAtStart = parseStorageEntries(localStorage.getItem(storyKey))
            .filter(e => e.isSelf).length;
    }

    /**
     * "Áp dụng" button: pick this chapter's active set — all "known"
     * phrases (if shown) plus up to `budget` learning phrases via SRS,
     * restricted to phrases actually present in the chapter text — and
     * write it to story storage. The site renders it on the next load,
     * so the user reloads when ready. Entirely user-triggered: no race
     * with the site's late content load on mobile.
     */
    function applyBudgetNow() {
        try {
            const storyKey = getLocalStorageKeyFromURL();
            if (!storyKey) {
                showNotification('Không xác định được key truyện từ URL', 'error');
                return;
            }
            const db = loadDB();
            if (db.settings.disabledStories.includes(storyKey)) {
                showNotification('Truyện này đang tắt học — bật lại trong bảng Học rồi thử lại', 'error');
                return;
            }
            const text = reconstructChapterText();
            if (!text) {
                showNotification('Chưa thấy nội dung chương — đợi trang tải xong rồi bấm lại', 'error');
                return;
            }

            const sel = selectActiveForChapter(db, text);
            writeActiveToStorage(storyKey, sel.active);
            DBG.lastWriteCount = sel.active.length;
            // Read straight back: did the write land?
            DBG.selfCountAfterWrite = parseStorageEntries(localStorage.getItem(storyKey))
                .filter(e => e.isSelf).length;

            updateChapterDiagnostics();
            updatePanelStats();

            const knownNote = (db.settings.showKnown && sel.knownPresent)
                ? ` + ${sel.knownPresent} đã thuộc` : '';
            showNotification(
                `Đã áp dụng ${sel.learningActive}/${sel.learningPresent} cụm đang học${knownNote} cho chương này — tải lại trang (F5) để hiển thị`,
                'success'
            );
        } catch (e) {
            reportError('Áp dụng thất bại', e);
        }
    }

    /**
     * After render (READ-ONLY): report this chapter's state in the panel —
     * how many learning phrases are present in the text, how many of those
     * are saved in story storage, and how many actually rendered as
     * Chinese. Never writes story storage (that's the Áp dụng button).
     */
    function updateChapterDiagnostics() {
        DBG.syncSkipped = null;
        const storyKey = getLocalStorageKeyFromURL();
        if (!storyKey) { DBG.syncSkipped = 'không có key truyện'; return; }
        const db = loadDB();
        const text = reconstructChapterText();
        if (!text) { DBG.syncSkipped = 'chưa thấy nội dung chương'; return; }

        const sel = selectActiveForChapter(db, text);

        const storedSelf = new Set(parseStorageEntries(localStorage.getItem(storyKey))
            .filter(e => e.isSelf).map(e => e.left));
        const storedLearning = [...storedSelf].filter(p =>
            p && isMaterializable(p) && text.includes(p) &&
            db.phrases[p] && db.phrases[p].status !== 'known');

        const rendered = new Set();
        document.querySelectorAll('.contentbox i[t]').forEach(el => {
            const t = (el.getAttribute('t') || '').trim();
            if (storedSelf.has(t) && el.textContent.trim() === t &&
                db.phrases[t] && db.phrases[t].status !== 'known') {
                rendered.add(t);
            }
        });

        chapterLearningActive = storedLearning.length;
        chapterLearningPresent = sel.learningPresent;
        chapterRenderedLearning = rendered.size;
        if (panelEl) updatePanelStats(Object.keys(lastChapterCounts).length);
    }

    // =====================================================================
    // Annotation: find kept-Chinese occurrences in the rendered chapter,
    // tag them for tooltips, harvest hv/meaning, count exposures.
    //
    // Chapter segments render as:
    //   <i h="hán việt" t="中文" v="nghĩa1/nghĩa2" p="pos" id="ranN">text</i>
    // A kept phrase renders with text equal to its t attribute.
    // =====================================================================

    // Distinct phrases rendered as Chinese in the current chapter,
    // with occurrence counts — feeds the panel's chapter overview.
    let lastChapterCounts = {};

    function annotateRenderedPhrases() {
        const db = loadDB();
        const counts = {};
        let dirty = false;

        document.querySelectorAll('i[t]').forEach(el => {
            const t = (el.getAttribute('t') || '').trim();
            if (!t) return;
            const info = db.phrases[t];
            if (!info) return;

            // Harvest only the Hán-Việt reading (h) — a deterministic
            // phonetic mapping. The site's v "meaning" is vietphrase MT and
            // unreliable, so meanings come from CC-CEDICT instead (see the
            // dictionary module), not from the page.
            const h = (el.getAttribute('h') || '').trim();
            if (h && !info.hv) { info.hv = h; dirty = true; }

            if (el.textContent.trim() !== t) return; // rendered as translation
            el.classList.add('stv-learn-phrase');
            el.classList.toggle('stv-learn-learning', info.status === 'learning');
            counts[t] = (counts[t] || 0) + 1;
        });

        // Exposure counting, once per chapter (keyed by pathname).
        const chapterFlag = 'stv-exposed:' + window.location.pathname;
        if (!sessionStorage.getItem(chapterFlag) && Object.keys(counts).length) {
            Object.entries(counts).forEach(([phrase, n]) => {
                const info = db.phrases[phrase];
                info.exposures += Math.min(n, MAX_EXPOSURES_PER_CHAPTER);
                info.lastSeen = todayStr();
            });
            sessionStorage.setItem(chapterFlag, '1');
            dirty = true;
        }

        if (dirty) saveDB(db);
        lastChapterCounts = counts;
        updatePanelStats(Object.keys(counts).length);
        updateChapterOverview();
    }

    /**
     * Re-annotate (debounced) whenever the site inserts chapter content.
     */
    function watchForChapterContent() {
        let timer = null;
        const schedule = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                // READ-ONLY passes: report chapter state, then annotate /
                // harvest the rendered keeps. Each step isolated: one
                // failing must not silently kill the other.
                try { updateChapterDiagnostics(); } catch (e) { reportError('Đọc trạng thái chương thất bại', e); }
                try { annotateRenderedPhrases(); } catch (e) { reportError('Đánh dấu cụm thất bại', e); }
            }, 1500);
        };
        const observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE &&
                        (node.matches && node.matches('i[t]') || node.querySelector && node.querySelector('i[t]'))) {
                        schedule();
                        return;
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        schedule(); // initial pass for content already present
    }

    // =====================================================================
    // Tooltip: hover/tap a kept phrase → pinyin + Hán-Việt + meaning +
    // audio + grade buttons
    // =====================================================================

    let tooltipEl = null;
    let tooltipHideTimer = null;
    let tooltipPhrase = null;

    function isTouchDevice() {
        return window.matchMedia('(pointer: coarse)').matches;
    }

    function ensureTooltip() {
        if (tooltipEl) return tooltipEl;
        tooltipEl = document.createElement('div');
        tooltipEl.id = 'stv-learn-tooltip';
        tooltipEl.addEventListener('mouseenter', () => clearTimeout(tooltipHideTimer));
        tooltipEl.addEventListener('mouseleave', scheduleTooltipHide);
        document.body.appendChild(tooltipEl);
        return tooltipEl;
    }

    function showTooltipFor(el) {
        const phrase = (el.getAttribute('t') || '').trim();
        if (!phrase) return;
        const db = loadDB();
        const info = db.phrases[phrase];
        if (!info) return;

        tooltipPhrase = phrase;
        const tip = ensureTooltip();
        const py = getPinyin(phrase);
        const hv = (el.getAttribute('h') || info.hv || '').trim();
        // Meaning is filled asynchronously from CC-CEDICT (see fillMeaning).
        const statusLabel = info.status === 'known' ? 'Đã thuộc' : 'Đang học';
        const suggest = info.status === 'learning' && info.exposures >= PROMOTE_SUGGEST_AT;

        tip.innerHTML = `
            <span class="stv-tip-close" title="Đóng">✕</span>
            <div class="stv-tip-phrase">${phrase}</div>
            <div class="stv-tip-pinyin">${py}</div>
            ${hv ? `<div class="stv-tip-hv">HV: ${hv}</div>` : ''}
            <div class="stv-tip-meaning" id="stv-tip-meaning"></div>
            <div class="stv-tip-meta">${statusLabel} · gặp ${info.exposures} lần${info.lapses ? ` · quên ${info.lapses}` : ''}</div>
            ${suggest ? '<div class="stv-tip-suggest">Gặp nhiều rồi — đã thuộc chưa?</div>' : ''}
            <div class="stv-tip-actions">
                <button data-act="speak" title="Phát âm">🔊</button>
                ${info.status === 'learning'
                    ? `<button data-act="promote" ${suggest ? 'class="stv-suggested"' : ''} title="Đánh dấu đã thuộc">✓ Thuộc</button>`
                    : '<button data-act="demote" title="Chuyển lại đang học">↩ Học lại</button>'}
                <button data-act="lapse" title="Quên nghĩa — ưu tiên hiện lại">✗ Quên</button>
            </div>
        `;

        const mobile = isTouchDevice();
        tip.classList.toggle('stv-mobile', mobile);
        tip.style.display = 'block';
        if (mobile) {
            // Bottom sheet — positioned by CSS, not inline styles.
            tip.style.left = '';
            tip.style.top = '';
        } else {
            const rect = el.getBoundingClientRect();
            tip.style.left = Math.max(8, Math.min(
                window.scrollX + rect.left,
                window.scrollX + document.documentElement.clientWidth - tip.offsetWidth - 8
            )) + 'px';
            tip.style.top = (window.scrollY + rect.bottom + 6) + 'px';
        }

        fillMeaning(phrase);
    }

    /**
     * Asynchronously fill the tooltip's meaning line from CC-CEDICT.
     * Guards against the user having moved to another phrase meanwhile.
     */
    async function fillMeaning(phrase) {
        const slot = () => tooltipEl && tooltipEl.querySelector('#stv-tip-meaning');
        let el = slot();
        if (!el) return;

        if (!(await isDictReady())) {
            if (tooltipPhrase === phrase && slot()) {
                slot().innerHTML = '<span class="stv-tip-nodict">Tải từ điển trong bảng Học để xem nghĩa</span>';
            }
            return;
        }

        const m = await lookupMeaning(phrase);
        if (tooltipPhrase !== phrase) return; // moved on
        el = slot();
        if (!el) return;
        if (!m) {
            el.textContent = '—';
            el.classList.remove('stv-perchar');
        } else {
            el.textContent = m.text;
            el.classList.toggle('stv-perchar', m.perChar);
        }
    }

    function scheduleTooltipHide() {
        clearTimeout(tooltipHideTimer);
        tooltipHideTimer = setTimeout(() => {
            if (tooltipEl) tooltipEl.style.display = 'none';
            tooltipPhrase = null;
        }, 250);
    }

    function handleTooltipAction(action) {
        if (!tooltipPhrase) return;
        const phrase = tooltipPhrase;

        if (action === 'speak') {
            speakText(phrase);
            return;
        }

        const db = loadDB();
        const info = db.phrases[phrase];
        if (!info) return;

        if (action === 'promote') {
            info.status = 'known';
            showNotification(`"${phrase}" → đã thuộc. Slot trống cho từ mới — bấm Áp dụng khi muốn!`, 'success');
        } else if (action === 'demote') {
            info.status = 'learning';
            showNotification(`"${phrase}" → học lại`, 'info');
        } else if (action === 'lapse') {
            info.lapses++;
            info.lastSeen = null; // jump the queue at the next Áp dụng
            if (info.status === 'known') info.status = 'learning';
            showNotification(`"${phrase}" sẽ được ưu tiên hiện lại`, 'info');
        }
        saveDB(db);
        if (tooltipEl) tooltipEl.style.display = 'none';
        updatePanelStats();
    }

    function setupTooltipDelegation() {
        document.addEventListener('mouseover', e => {
            const el = e.target.closest && e.target.closest('.stv-learn-phrase');
            if (el) {
                clearTimeout(tooltipHideTimer);
                showTooltipFor(el);
            }
        });
        document.addEventListener('mouseout', e => {
            // Touch browsers fire unreliable mouseout right after a tap,
            // which would close the sheet immediately — close is explicit there.
            if (isTouchDevice()) return;
            const el = e.target.closest && e.target.closest('.stv-learn-phrase');
            if (el) scheduleTooltipHide();
        });
        // Tap support (phone reading): tap a phrase to show, tap elsewhere to hide.
        document.addEventListener('click', e => {
            if (tooltipEl && tooltipEl.contains(e.target)) {
                if (e.target.closest('.stv-tip-close')) {
                    tooltipEl.style.display = 'none';
                    tooltipPhrase = null;
                    return;
                }
                const btn = e.target.closest('button[data-act]');
                if (btn) handleTooltipAction(btn.dataset.act);
                return;
            }
            const el = e.target.closest && e.target.closest('.stv-learn-phrase');
            if (el) {
                clearTimeout(tooltipHideTimer);
                showTooltipFor(el);
            } else if (tooltipEl) {
                tooltipEl.style.display = 'none';
            }
        });
    }

    /**
     * Speak arbitrary text via speech synthesis (zh-CN).
     */
    function speakText(text) {
        if (!('speechSynthesis' in window)) {
            showNotification('Speech synthesis not supported in this browser', 'error');
            return;
        }
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'zh-CN';
        utterance.rate = 0.85;
        const voices = speechSynthesis.getVoices();
        const zhVoice = voices.find(v => v.lang && v.lang.toLowerCase().startsWith('zh'));
        if (zhVoice) utterance.voice = zhVoice;
        speechSynthesis.cancel();
        speechSynthesis.speak(utterance);
    }

    // =====================================================================
    // Dictionary (CC-CEDICT) — reliable, community-maintained meanings.
    //
    // Downloaded once (~25 MB) from the krmanik/cedict-json mirror (CORS-
    // enabled GitHub raw), stored per-entry in IndexedDB keyed by simplified
    // string, so lookups are local + offline afterwards. The site's own v
    // "meaning" (vietphrase MT) is NOT trusted and not used.
    // =====================================================================

    const DICT_URL = 'https://raw.githubusercontent.com/krmanik/cedict-json/master/all_cedict.json';
    const DICT_DB = 'STV_DICT_DB';
    const DICT_STORE = 'cedict';
    let dictDbPromise = null;
    let dictReadyCache = null; // null = unknown, true/false once checked
    const meaningCache = new Map();

    function openDictDb() {
        if (dictDbPromise) return dictDbPromise;
        dictDbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DICT_DB, 1);
            req.onupgradeneeded = () => {
                const idb = req.result;
                if (!idb.objectStoreNames.contains(DICT_STORE)) {
                    idb.createObjectStore(DICT_STORE); // key = simplified (external)
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return dictDbPromise;
    }

    function dictGet(key) {
        return openDictDb().then(idb => new Promise((resolve, reject) => {
            const tx = idb.transaction(DICT_STORE, 'readonly');
            const req = tx.objectStore(DICT_STORE).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        }));
    }

    function dictCount() {
        return openDictDb().then(idb => new Promise((resolve, reject) => {
            const tx = idb.transaction(DICT_STORE, 'readonly');
            const req = tx.objectStore(DICT_STORE).count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }));
    }

    async function isDictReady() {
        if (dictReadyCache !== null) return dictReadyCache;
        try {
            dictReadyCache = (await dictCount()) > 0;
        } catch (e) {
            dictReadyCache = false;
        }
        return dictReadyCache;
    }

    // Flatten a CC-CEDICT entry's definitions object into one gloss string.
    function flattenDefs(entry) {
        if (!entry || !entry.definitions) return '';
        return Object.values(entry.definitions)
            .join(' ')
            .replace(/\s*;\s*$/, '')
            .trim();
    }

    async function downloadDict() {
        showNotification('Đang tải từ điển CC-CEDICT (~25MB)…', 'info');
        let json;
        try {
            const res = await fetch(DICT_URL);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            json = await res.json();
        } catch (e) {
            console.error('STV-Dict: download failed', e);
            showNotification('Tải từ điển thất bại — kiểm tra mạng rồi thử lại', 'error');
            return false;
        }

        const idb = await openDictDb();
        const keys = Object.keys(json);
        const CHUNK = 5000;
        for (let i = 0; i < keys.length; i += CHUNK) {
            await new Promise((resolve, reject) => {
                const tx = idb.transaction(DICT_STORE, 'readwrite');
                const store = tx.objectStore(DICT_STORE);
                for (let j = i; j < Math.min(i + CHUNK, keys.length); j++) {
                    store.put(flattenDefs(json[keys[j]]), keys[j]);
                }
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
            if (i % 25000 === 0) {
                showNotification(`Đang lưu từ điển… ${Math.round(i / keys.length * 100)}%`, 'info');
            }
        }
        dictReadyCache = true;
        meaningCache.clear();
        showNotification(`Từ điển sẵn sàng: ${keys.length} mục (offline)`, 'success');
        updateDictStatus();
        return true;
    }

    // First gloss sense, for compact per-character display.
    function firstSense(gloss) {
        return (gloss || '').split(/;\s*/)[0].trim();
    }

    /**
     * Look up a phrase's meaning from CC-CEDICT. Returns
     * { text, perChar } or null. For phrases not in the dictionary,
     * falls back to per-character glosses.
     */
    async function lookupMeaning(phrase) {
        if (meaningCache.has(phrase)) return meaningCache.get(phrase);
        if (!(await isDictReady())) return null;

        let out = null;
        const direct = await dictGet(phrase);
        if (direct) {
            out = { text: direct, perChar: false };
        } else if ([...phrase].length > 1) {
            const parts = [];
            for (const ch of phrase) {
                const g = await dictGet(ch);
                if (g) parts.push(`${ch} ${firstSense(g)}`);
            }
            if (parts.length) out = { text: parts.join(' · '), perChar: true };
        }
        meaningCache.set(phrase, out);
        return out;
    }

    // =====================================================================
    // Anki export
    // =====================================================================

    /**
     * Copy the whole DB as TSV, ready for Anki import (tab-separated):
     * phrase, pinyin, hán việt, meaning (CC-CEDICT), status, exposures, added
     */
    async function exportAnkiTSV() {
        const db = loadDB();
        const phrases = Object.keys(db.phrases);
        if (!phrases.length) {
            showNotification('No phrases in learning DB yet', 'error');
            return;
        }
        const dictOn = await isDictReady();
        const rows = [];
        for (const phrase of phrases) {
            const info = db.phrases[phrase];
            const py = getPinyin(phrase).replace(/\t/g, ' ');
            let meaning = '';
            if (dictOn) {
                const m = await lookupMeaning(phrase);
                if (m) meaning = m.text.replace(/\t/g, ' ');
            }
            rows.push([phrase, py, info.hv || '', meaning, info.status, info.exposures, info.added].join('\t'));
        }
        const ok = await copyToClipboard(rows.join('\n'));
        showNotification(ok
            ? `Copied ${rows.length} phrases as TSV${dictOn ? ' (with CC-CEDICT)' : ' (no dict — load it for meanings)'}`
            : 'Failed to copy', ok ? 'success' : 'error');
    }

    // =====================================================================
    // Control panel
    // =====================================================================

    let panelEl = null;

    function buildPanel() {
        if (panelEl) return panelEl;
        const db = loadDB();
        const storyKey = getLocalStorageKeyFromURL();
        const storyDisabled = storyKey && db.settings.disabledStories.includes(storyKey);

        panelEl = document.createElement('div');
        panelEl.id = 'stv-learn-panel';
        panelEl.innerHTML = `
            <div class="stv-panel-title">Học tiếng Trung 学中文
                <span id="stv-panel-close" title="Đóng">✕</span>
            </div>
            <label class="stv-panel-row">
                Số cụm đang học hiển thị: <b id="stv-budget-value">${db.settings.budget}</b>
                <input type="range" id="stv-budget-slider" min="0" max="60" step="1" value="${db.settings.budget}">
            </label>
            <div class="stv-panel-row" id="stv-panel-stats"></div>
            <div class="stv-panel-row stv-manual-row">
                <input type="text" id="stv-manual-input" placeholder="Thêm chữ/cụm Trung..." autocomplete="off">
                <button id="stv-manual-btn" title="Thêm vào DB học">Thêm</button>
            </div>
            <label class="stv-panel-row">
                <input type="checkbox" id="stv-known-toggle" ${db.settings.showKnown ? 'checked' : ''}>
                Hiện cụm đã thuộc
            </label>
            <label class="stv-panel-row">
                <input type="checkbox" id="stv-story-toggle" ${storyDisabled ? '' : 'checked'}>
                Bật học cho truyện này
            </label>
            <div class="stv-panel-row stv-panel-buttons">
                <button id="stv-apply-btn" title="Chọn cụm theo budget cho chương này và lưu vào kho — tải lại trang để hiển thị">Áp dụng</button>
                <button id="stv-export-btn" title="Copy TSV (chữ, pinyin, Hán Việt, nghĩa) để import vào Anki">Xuất Anki</button>
            </div>
            <div class="stv-panel-row" id="stv-dict-row">
                <span id="stv-dict-status">Từ điển: …</span>
                <button id="stv-dict-btn" style="display:none;">Tải từ điển (~25MB)</button>
            </div>
            <div class="stv-panel-row" id="stv-chapter-overview"></div>
            <div class="stv-panel-row" id="stv-debug-row"></div>
            <div class="stv-panel-hint">Bấm <b>Áp dụng</b> để chọn cụm cho chương này, rồi tải lại trang để hiển thị. Mệt thì kéo slider xuống.</div>
        `;
        document.body.appendChild(panelEl);

        const slider = panelEl.querySelector('#stv-budget-slider');
        slider.addEventListener('input', () => {
            panelEl.querySelector('#stv-budget-value').textContent = slider.value;
        });
        slider.addEventListener('change', () => {
            const db2 = loadDB();
            db2.settings.budget = parseInt(slider.value, 10);
            saveDB(db2);
            showNotification(`Budget: ${slider.value} cụm — bấm Áp dụng để dùng`, 'info');
            updatePanelStats();
        });

        const manualInput = panelEl.querySelector('#stv-manual-input');
        const submitManual = () => {
            const value = manualInput.value.trim();
            if (!value) return;
            const result = learnAddPhrase(value);
            if (result === 'error') return; // saveDB already told the user
            manualInput.value = '';
            // Materialize the explicit add into this story right away so
            // it shows after a reload without an Áp dụng pass.
            if (result === 'added' && isMaterializable(value)) appendSelfEntryToStory(value);
            updatePanelStats();
            refreshNewHighlight();
            const singleNote = !isMaterializable(value) ? ' (1 ký tự: chỉ Anki + nhận diện)' : '';
            showNotification(result === 'added'
                ? `Đã thêm "${value}"${singleNote} — tải lại trang để hiện trong chương này`
                : `"${value}" đã có trong kho`, result === 'added' ? 'success' : 'info');
        };
        panelEl.querySelector('#stv-manual-btn').addEventListener('click', submitManual);
        manualInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); submitManual(); }
        });

        panelEl.querySelector('#stv-known-toggle').addEventListener('change', e => {
            const db2 = loadDB();
            db2.settings.showKnown = e.target.checked;
            saveDB(db2);
            showNotification(e.target.checked
                ? 'Cụm đã thuộc sẽ hiển thị (bấm Áp dụng để cập nhật)'
                : 'Ẩn cụm đã thuộc — slider 0 = tắt hẳn (bấm Áp dụng để cập nhật)', 'info');
            updatePanelStats();
        });

        panelEl.querySelector('#stv-story-toggle').addEventListener('change', e => {
            const key = getLocalStorageKeyFromURL();
            if (!key) return;
            const db2 = loadDB();
            const list = db2.settings.disabledStories;
            if (e.target.checked) {
                db2.settings.disabledStories = list.filter(k => k !== key);
            } else if (!list.includes(key)) {
                list.push(key);
                // Strip the materialized $X=X entries from this story so the
                // Chinese actually disappears (from the next chapter load).
                // Manual single-char keeps and real translations stay.
                const entries = parseStorageEntries(localStorage.getItem(key));
                const keep = entries.filter(en =>
                    !en.isSelf || (en.left && !isMaterializable(en.left))
                );
                localStorage.setItem(key, keep.length ? keep.map(en => en.raw).join('~//~') + '~//~' : '');
            }
            saveDB(db2);
            showNotification(e.target.checked
                ? 'Bật học cho truyện này — bấm Áp dụng để chọn cụm'
                : 'Tắt học cho truyện này — chữ Trung sẽ biến mất sau khi tải lại', 'info');
        });

        panelEl.querySelector('#stv-panel-close').addEventListener('click', togglePanel);
        panelEl.querySelector('#stv-apply-btn').addEventListener('click', applyBudgetNow);
        panelEl.querySelector('#stv-export-btn').addEventListener('click', exportAnkiTSV);

        panelEl.querySelector('#stv-dict-btn').addEventListener('click', async () => {
            const btn = panelEl.querySelector('#stv-dict-btn');
            btn.disabled = true;
            btn.textContent = 'Đang tải…';
            await downloadDict();
            updateDictStatus();
        });
        updateDictStatus();

        // Chapter overview: tap a phrase chip to scroll to its first
        // occurrence and flash it.
        panelEl.querySelector('#stv-chapter-overview').addEventListener('click', e => {
            const chip = e.target.closest('.stv-chip');
            if (!chip) return;
            const phrase = chip.dataset.phrase;
            const target = [...document.querySelectorAll('i[t]')].find(el =>
                (el.getAttribute('t') || '').trim() === phrase &&
                el.textContent.trim() === phrase
            );
            if (!target) return;
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            target.classList.add('stv-flash');
            setTimeout(() => target.classList.remove('stv-flash'), 2000);
        });

        updatePanelStats();
        updateChapterOverview();
        updateDebugRow();
        return panelEl;
    }

    /**
     * Update the dictionary status line + load button in the panel.
     */
    async function updateDictStatus() {
        if (!panelEl) return;
        const statusEl = panelEl.querySelector('#stv-dict-status');
        const btn = panelEl.querySelector('#stv-dict-btn');
        if (!statusEl || !btn) return;
        const ready = await isDictReady();
        if (ready) {
            const n = await dictCount();
            statusEl.textContent = `Từ điển CC-CEDICT: ${n} mục ✓`;
            btn.style.display = 'none';
        } else {
            statusEl.textContent = 'Từ điển CC-CEDICT: chưa tải';
            btn.style.display = '';
            btn.disabled = false;
            btn.textContent = 'Tải từ điển (~25MB)';
        }
    }

    /**
     * Storage diagnostics readout. Lets the user (who can't open a console
     * on iOS) see whether localStorage writes survive and whether the site
     * clobbers our story-key write.
     */
    function updateDebugRow() {
        if (!panelEl) return;
        const el = panelEl.querySelector('#stv-debug-row');
        if (!el) return;

        const persist = DBG.persistOK
            ? `OK (lần ${DBG.persistPrev})`
            : (DBG.persistPrev === null ? 'CHƯA (lần đầu)' : 'LỖI');

        // Current $X=X count in story storage right now (post-site-activity).
        let nowCount = '—';
        if (DBG.storyKeyAtStart) {
            nowCount = parseStorageEntries(localStorage.getItem(DBG.storyKeyAtStart))
                .filter(e => e.isSelf).length;
        }

        // Total localStorage usage — quota trouble (iOS ~5MB) shows up here.
        let usage = '—';
        try {
            let chars = 0;
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                chars += k.length + (localStorage.getItem(k) || '').length;
            }
            usage = Math.round(chars * 2 / 1024) + ' KB';
        } catch (e) { /* leave dash */ }

        const fmt = v => (v === null || v === undefined) ? '—' : v;
        const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

        el.innerHTML =
            `<b>Debug</b> · key: <code>${DBG.storyKeyAtStart || '—'}</code>` +
            `<br>Lưu sống sót qua reload: <b>${persist}</b> · dung lượng: <b>${usage}</b>` +
            `<br>$X=X lúc vào: <b>${fmt(DBG.selfCountAtStart)}</b> · sau khi ghi: <b>${fmt(DBG.selfCountAfterWrite)}</b> · bây giờ: <b>${nowCount}</b> (đã ghi ${fmt(DBG.lastWriteCount)})` +
            (DBG.syncSkipped ? `<br>Chẩn đoán chương bỏ qua: <b>${esc(DBG.syncSkipped)}</b>` : '') +
            (DBG.errors.length
                ? `<br><span style="color:#C62828">Lỗi gần đây:<br>${DBG.errors.slice(-3).map(esc).join('<br>')}</span>`
                : '');
    }

    /**
     * Render the per-chapter overview: how many phrases the budget applied
     * to this chapter, occurrence totals, and a chip per distinct phrase
     * (purple border = learning, teal = known; tap to jump to it).
     */
    function updateChapterOverview() {
        if (!panelEl) return;
        const container = panelEl.querySelector('#stv-chapter-overview');
        if (!container) return;

        const phrases = Object.keys(lastChapterCounts);
        if (!phrases.length) {
            container.innerHTML = '<div class="stv-overview-title">Chương này: chưa có cụm nào hiển thị</div>';
            return;
        }

        const db = loadDB();
        const totalOccurrences = Object.values(lastChapterCounts).reduce((a, b) => a + b, 0);

        const learningPhrases = phrases.filter(p => {
            const info = db.phrases[p];
            return !info || info.status !== 'known';
        });
        const knownCount = phrases.length - learningPhrases.length;

        // Only learning phrases get chips (known ones need no review action);
        // most frequent first.
        learningPhrases.sort((a, b) => lastChapterCounts[b] - lastChapterCounts[a]);

        const chips = learningPhrases.map(p =>
            `<span class="stv-chip stv-chip-learning" data-phrase="${p}" title="Bấm để nhảy tới">${p} <small>×${lastChapterCounts[p]}</small></span>`
        ).join('');

        container.innerHTML = `
            <div class="stv-overview-title">Chương này: <b>${phrases.length}</b> cụm (${learningPhrases.length} đang học, ${knownCount} đã thuộc) · <b>${totalOccurrences}</b> lần xuất hiện</div>
            ${chips ? `<div class="stv-overview-chips">${chips}</div>` : ''}
        `;
    }

    function updatePanelStats(annotatedCount) {
        if (!panelEl) return;
        updateDebugRow();
        const db = loadDB();
        const { known, learningTotal, singles } = selectActivePhrases(db);

        // Distinct characters across all collected phrases — the real
        // reading-ability unit. Track total vs. those in "known" phrases.
        const allChars = new Set();
        const knownChars = new Set();
        Object.entries(db.phrases).forEach(([phrase, info]) => {
            for (const ch of phrase) {
                if (!/[一-鿿]/.test(ch)) continue;
                allChars.add(ch);
                if (info.status === 'known') knownChars.add(ch);
            }
        });

        const statsEl = panelEl.querySelector('#stv-panel-stats');
        if (statsEl) {
            // "đã lưu X/Y đang học (đang hiện Z)": X are saved in story
            // storage and present here, Y are present in the chapter, Z are
            // rendered as Chinese right now. Z < X → reload to apply the
            // stored set; X = 0 → press Áp dụng to pick a set.
            const chapterInfo = (chapterLearningPresent !== null)
                ? ` · Chương này: đã lưu <b>${chapterLearningActive}</b>/${chapterLearningPresent} đang học` +
                  (chapterRenderedLearning !== null ? ` (đang hiện ${chapterRenderedLearning})` : '')
                : '';
            statsEl.innerHTML =
                `Đang học: <b>${learningTotal}</b>` +
                ` · Đã thuộc: <b>${known.length}</b>` +
                (singles ? ` · 1 ký tự: <b>${singles}</b> (chỉ Anki)` : '') +
                `<br>Ký tự khác nhau: <b>${allChars.size}</b> (đã thuộc ${knownChars.size})` +
                chapterInfo;
        }
    }

    function togglePanel() {
        const panel = buildPanel();
        panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
        if (panel.style.display === 'block') updatePanelStats();
    }

    /**
     * Floating "Học" button alongside Chạy/Merge/Scan/Wipe.
     */
    function addLearnButton() {
        const button = document.createElement('button');
        button.textContent = 'Học';
        styleBarButton(button, '#00897B', '#00695C');
        button.addEventListener('click', togglePanel);
        ensureButtonBar().appendChild(button);
    }

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .stv-learn-phrase { cursor: help; }
            .stv-learn-phrase.stv-learn-learning {
                border-bottom: 2px dotted #9C27B0;
            }
            #stv-learn-tooltip {
                display: none;
                position: absolute;
                z-index: 10002;
                background: #263238;
                color: #fff;
                padding: 10px 12px;
                border-radius: 8px;
                font-family: Arial, sans-serif;
                font-size: 13px;
                max-width: 300px;
                box-shadow: 0 4px 16px rgba(0,0,0,0.35);
                line-height: 1.5;
            }
            #stv-learn-tooltip .stv-tip-close {
                position: absolute; top: 4px; right: 8px;
                color: #B0BEC5; cursor: pointer; padding: 4px;
            }
            #stv-learn-tooltip .stv-tip-phrase { font-size: 20px; }
            #stv-learn-tooltip .stv-tip-pinyin { color: #80CBC4; font-size: 15px; }
            #stv-learn-tooltip .stv-tip-hv { color: #FFCC80; font-size: 13px; }
            #stv-learn-tooltip .stv-tip-meaning { color: #ECEFF1; font-size: 13px; }
            #stv-learn-tooltip .stv-tip-meaning.stv-perchar { color: #B0BEC5; font-style: italic; }
            #stv-learn-tooltip .stv-tip-nodict { color: #90A4AE; font-size: 12px; }
            #stv-learn-tooltip .stv-tip-meta { color: #B0BEC5; font-size: 12px; }
            #stv-learn-tooltip .stv-tip-suggest { color: #FFD54F; font-size: 12px; margin-top: 2px; }
            #stv-learn-tooltip .stv-tip-actions { margin-top: 6px; display: flex; gap: 6px; }
            #stv-learn-tooltip button {
                background: #37474F; color: #fff; border: none; border-radius: 4px;
                padding: 4px 8px; cursor: pointer; font-size: 12px;
            }
            #stv-learn-tooltip button:hover { background: #455A64; }
            #stv-learn-tooltip button.stv-suggested { background: #F9A825; color: #000; }
            #stv-learn-tooltip.stv-mobile {
                position: fixed;
                left: 8px !important;
                right: 8px;
                top: auto !important;
                bottom: 8px;
                max-width: none;
                font-size: 15px;
                padding: 14px;
                border-radius: 12px;
            }
            #stv-learn-tooltip.stv-mobile .stv-tip-close { font-size: 18px; padding: 8px; }
            #stv-learn-tooltip.stv-mobile .stv-tip-phrase { font-size: 28px; }
            #stv-learn-tooltip.stv-mobile .stv-tip-pinyin { font-size: 19px; }
            #stv-learn-tooltip.stv-mobile .stv-tip-hv,
            #stv-learn-tooltip.stv-mobile .stv-tip-meaning { font-size: 15px; }
            #stv-learn-tooltip.stv-mobile .stv-tip-actions { margin-top: 10px; gap: 10px; }
            #stv-learn-tooltip.stv-mobile button {
                padding: 12px 14px; font-size: 16px; flex: 1;
            }
            #stv-learn-panel {
                display: none;
                position: fixed;
                bottom: 80px;
                right: 28px;
                width: 290px;
                background: #FAFAFA;
                color: #212121;
                border: 1px solid #BDBDBD;
                border-radius: 8px;
                padding: 12px;
                z-index: 10001;
                font-family: Arial, sans-serif;
                font-size: 13px;
                box-shadow: 0 4px 16px rgba(0,0,0,0.25);
            }
            #stv-learn-panel .stv-panel-title {
                font-weight: bold; font-size: 14px; margin-bottom: 8px;
                display: flex; justify-content: space-between;
            }
            #stv-learn-panel #stv-panel-close { cursor: pointer; color: #757575; }
            #stv-learn-panel .stv-panel-row { display: block; margin-bottom: 8px; }
            #stv-learn-panel input[type=range] { width: 100%; }
            /* The site hides/restyles native checkboxes — force ours back. */
            #stv-learn-panel input[type=checkbox] {
                all: revert;
                appearance: auto;
                -webkit-appearance: checkbox;
                display: inline-block;
                width: 16px;
                height: 16px;
                margin: 0 8px 0 0;
                opacity: 1;
                position: static;
                vertical-align: middle;
                accent-color: #00897B;
                cursor: pointer;
            }
            #stv-learn-panel label.stv-panel-row { cursor: pointer; }
            #stv-learn-panel .stv-manual-row { display: flex; gap: 6px; }
            #stv-learn-panel #stv-manual-input {
                all: revert;
                flex: 1;
                min-width: 0;
                padding: 6px 8px;
                font-size: 14px;
                border: 1px solid #BDBDBD;
                border-radius: 4px;
                background: #fff;
                color: #212121;
            }
            #stv-learn-panel #stv-manual-btn {
                background: #00897B; color: #fff; border: none;
                border-radius: 4px; padding: 6px 12px; cursor: pointer; font-size: 12px;
            }
            #stv-learn-panel #stv-manual-btn:hover { background: #00695C; }
            #stv-learn-panel #stv-dict-row { font-size: 12px; color: #555; }
            #stv-learn-panel #stv-debug-row {
                font-size: 11px; color: #555; background: #F0F0F0;
                border-radius: 4px; padding: 6px; line-height: 1.5;
            }
            #stv-learn-panel #stv-debug-row code { font-size: 11px; word-break: break-all; }
            #stv-learn-panel #stv-dict-btn {
                margin-left: 8px; background: #5C6BC0; color: #fff; border: none;
                border-radius: 4px; padding: 5px 10px; cursor: pointer; font-size: 12px;
            }
            #stv-learn-panel #stv-dict-btn:hover { background: #3F51B5; }
            #stv-learn-panel #stv-dict-btn:disabled { background: #9FA8DA; cursor: default; }
            #stv-learn-panel .stv-panel-buttons { display: flex; gap: 6px; }
            #stv-learn-panel .stv-panel-buttons button {
                flex: 1; background: #00897B; color: #fff; border: none;
                border-radius: 4px; padding: 6px 4px; cursor: pointer; font-size: 12px;
            }
            #stv-learn-panel .stv-panel-buttons button:hover { background: #00695C; }
            #stv-learn-panel .stv-panel-hint { color: #757575; font-size: 11px; }
            #stv-learn-panel .stv-overview-title { font-size: 12px; margin-bottom: 4px; }
            #stv-learn-panel .stv-overview-chips {
                max-height: 140px; overflow-y: auto;
                display: flex; flex-wrap: wrap; gap: 4px;
            }
            #stv-learn-panel .stv-chip {
                display: inline-block; padding: 2px 7px; border-radius: 10px;
                background: #fff; cursor: pointer; font-size: 14px;
                border: 1.5px solid #9C27B0;
            }
            #stv-learn-panel .stv-chip small { color: #757575; font-size: 10px; }
            #stv-learn-panel .stv-chip.stv-chip-known { border-color: #00897B; }
            #stv-learn-panel .stv-chip:hover { background: #F3E5F5; }
            #stv-learn-panel .stv-chip.stv-chip-known:hover { background: #E0F2F1; }
            i.stv-flash {
                outline: 3px solid #FFD54F !important;
                outline-offset: 2px;
                transition: outline-color 0.3s ease;
            }
            i.stv-new-highlight {
                background-color: #FFF59D !important;
                color: #000 !important;
                outline: 1px dashed #F9A825 !important;
                border-radius: 2px;
            }
            @media (max-width: 480px) {
                #stv-learn-panel {
                    left: 8px;
                    right: 8px;
                    width: auto;
                    bottom: 130px;
                }
            }
        `;
        document.head.appendChild(style);
    }

    // =====================================================================
    // ===== Original features (extract, merge, scan, wipe, add, pinyin
    // ===== row, speak) — unchanged behavior unless noted.
    // =====================================================================

    /**
     * Load pinyin library dynamically (fallback if @require didn't run)
     */
    function loadPinyinLibrary() {
        return new Promise((resolve, reject) => {
            if (typeof pinyin !== 'undefined') {
                resolve();
                return;
            }
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/pinyin@4.0.0/lib/umd/pinyin.min.js';
            script.crossOrigin = 'anonymous';
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Failed to load pinyin library'));
            document.head.appendChild(script);
        });
    }

    /**
     * Extract localStorage key pattern from URL
     * For URL: https://sangtacviet.com/truyen/qidian/1/1046597676/864072902/
     * Returns: "qidian1046597676"
     */
    function getLocalStorageKeyFromURL() {
        const url = window.location.pathname;
        const pathParts = url.split('/');
        if (pathParts.length >= 5 && pathParts[1] === 'truyen') {
            const platform = pathParts[2];
            const id = pathParts[4];
            return platform + id;
        }
        return null;
    }

    /**
     * Copy text to clipboard using modern Clipboard API or fallback
     */
    async function copyToClipboard(text) {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                return true;
            } else {
                const textArea = document.createElement('textarea');
                textArea.value = text;
                textArea.style.position = 'fixed';
                textArea.style.left = '-9999px';
                textArea.style.top = '-9999px';
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                const successful = document.execCommand('copy');
                document.body.removeChild(textArea);
                return successful;
            }
        } catch (err) {
            console.error('Failed to copy to clipboard:', err);
            return false;
        }
    }

    /**
     * Extract localStorage value and copy to clipboard (Ctrl+Shift+E)
     */
    async function extractAndCopyLocalStorage() {
        const storageKey = getLocalStorageKeyFromURL();
        if (!storageKey) {
            showNotification('Could not determine localStorage key from URL', 'error');
            return;
        }
        const storageValue = localStorage.getItem(storageKey);
        if (storageValue === null) {
            showNotification(`localStorage key "${storageKey}" not found`, 'error');
            return;
        }

        const uniqueEntries = [...new Set(
            parseStorageEntries(storageValue).filter(e => e.isSelf).map(e => e.raw)
        )];
        uniqueEntries.sort((a, b) => a.length - b.length);

        const success = await copyToClipboard(uniqueEntries.join('\n'));
        showNotification(
            success ? `Copied "${storageKey}" to clipboard!` : 'Failed to copy to clipboard',
            success ? 'success' : 'error'
        );
    }

    /**
     * Show a temporary notification to the user
     */
    const pendingNotifications = [];
    function flushPendingNotifications() {
        while (pendingNotifications.length && document.body) {
            const [m, t] = pendingNotifications.shift();
            showNotification(m, t);
        }
    }

    function showNotification(message, type = 'info') {
        // document-start: no <body> yet — queue and show after DOM is ready.
        if (!document.body) {
            pendingNotifications.push([message, type]);
            document.addEventListener('DOMContentLoaded', flushPendingNotifications, { once: true });
            return;
        }
        const notification = document.createElement('div');
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 10px 15px;
            border-radius: 5px;
            color: white;
            font-family: Arial, sans-serif;
            font-size: 14px;
            z-index: 10000;
            opacity: 0;
            transition: opacity 0.3s ease;
            max-width: 300px;
            word-wrap: break-word;
        `;
        switch (type) {
            case 'success': notification.style.backgroundColor = '#4CAF50'; break;
            case 'error': notification.style.backgroundColor = '#f44336'; break;
            default: notification.style.backgroundColor = '#2196F3';
        }
        document.body.appendChild(notification);
        setTimeout(() => { notification.style.opacity = '1'; }, 10);
        setTimeout(() => {
            notification.style.opacity = '0';
            setTimeout(() => {
                if (notification.parentNode) notification.parentNode.removeChild(notification);
            }, 300);
        }, 3000);
    }

    /**
     * Shared container for the floating buttons. A wrapping flex row
     * anchored bottom-right: on narrow (mobile) screens buttons wrap into
     * extra rows above instead of running off the left edge.
     * First-added button renders rightmost (row-reverse).
     */
    let buttonBarEl = null;
    function ensureButtonBar() {
        if (buttonBarEl) return buttonBarEl;
        buttonBarEl = document.createElement('div');
        buttonBarEl.id = 'stv-button-bar';
        buttonBarEl.style.cssText = `
            position: fixed;
            bottom: 28px;
            right: 80px;
            display: flex;
            flex-direction: row-reverse;
            flex-wrap: wrap;
            gap: 6px;
            justify-content: flex-start;
            max-width: calc(100vw - 96px);
            z-index: 10000;
        `;
        document.body.appendChild(buttonBarEl);
        return buttonBarEl;
    }

    function styleBarButton(button, color, hoverColor) {
        button.style.cssText = `
            padding: 10px 15px;
            background-color: ${color};
            color: white;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-family: Arial, sans-serif;
            font-size: 14px;
            transition: background-color 0.3s ease;
        `;
        button.addEventListener('mouseover', () => { button.style.backgroundColor = hoverColor; });
        button.addEventListener('mouseout', () => { button.style.backgroundColor = color; });
    }

    /**
     * Create and add run button to the page
     */
    function addRunButton() {
        const button = document.createElement('button');
        button.textContent = 'Chạy';
        styleBarButton(button, '#2196F3', '#1976D2');
        button.addEventListener('click', () => {
            try {
                if (typeof saveNS === 'function') saveNS();
                if (typeof excute === 'function') excute();
                setTimeout(annotateRenderedPhrases, 1500);
            } catch (error) {
                console.error('Error executing run functions:', error);
                showNotification('Error executing run functions', 'error');
            }
        });
        ensureButtonBar().appendChild(button);
    }

    /**
     * Create and add the scan button. Scans the rendered chapter and
     * auto-collects candidate phrases into the learning DB (see
     * scanAndCollect).
     */
    function addScanButton() {
        const button = document.createElement('button');
        button.textContent = 'Scan';
        styleBarButton(button, '#9C27B0', '#7B1FA2');
        button.addEventListener('click', scanAndCollect);
        ensureButtonBar().appendChild(button);
    }

    /**
     * Add a phrase/character to the learning DB. Returns true if newly
     * added. Harvests the Hán-Việt reading from a matching rendered segment
     * if present (meanings come from CC-CEDICT, not the page).
     */
    function learnAddPhrase(phrase) {
        phrase = (phrase || '').trim();
        if (!phrase) return 'empty';
        const db = loadDB();
        const added = dbAddPhrase(db, phrase);
        const seg = [...document.querySelectorAll('i[t]')].find(el =>
            (el.getAttribute('t') || '').trim() === phrase
        );
        if (seg) {
            const info = db.phrases[phrase];
            const h = (seg.getAttribute('h') || '').trim();
            if (h && !info.hv) info.hv = h;
        }
        if (!saveDB(db)) return 'error';
        return added ? 'added' : 'exists';
    }

    /**
     * "Mới" toggle: highlight every <i t> segment whose phrase is NOT yet
     * in the learning DB (or stored as $X=X) — i.e. material you haven't
     * collected. While active, clicking a highlighted segment adds it.
     * The complement of Scan: Scan grabs all-known phrases automatically;
     * this surfaces phrases containing new characters to add by hand.
     */
    let newHighlightActive = false;

    function collectedSet() {
        const db = loadDB();
        const collected = new Set(Object.keys(db.phrases));
        const storyKey = getLocalStorageKeyFromURL();
        [storyKey, GLOBAL_KEY].forEach(key => {
            if (!key) return;
            parseStorageEntries(localStorage.getItem(key)).forEach(entry => {
                if (entry.isSelf && entry.left) collected.add(entry.left);
            });
        });
        return collected;
    }

    function applyNewHighlight() {
        const collected = collectedSet();
        // Characters you already have, from every collected phrase.
        const knownChars = new Set();
        collected.forEach(p => {
            for (const ch of p) knownChars.add(ch);
        });

        let count = 0;
        document.querySelectorAll('i[t]').forEach(el => {
            const t = (el.getAttribute('t') || '').trim();
            // Only Chinese segments, not already collected.
            if (!t || collected.has(t)) return;
            if (!/[一-鿿]/.test(t)) return;
            // Highlight ONLY phrases with a character you don't have yet.
            // All-known-character phrases are Scan's job, not yours.
            if ([...t].every(ch => knownChars.has(ch))) return;
            el.classList.add('stv-new-highlight');
            count++;
        });
        return count;
    }

    function clearNewHighlight() {
        document.querySelectorAll('i.stv-new-highlight').forEach(el =>
            el.classList.remove('stv-new-highlight')
        );
    }

    function refreshNewHighlight() {
        if (!newHighlightActive) return;
        clearNewHighlight();
        applyNewHighlight();
    }

    function addNewHighlightButton() {
        const button = document.createElement('button');
        button.textContent = 'Mới';
        styleBarButton(button, '#5C6BC0', '#3F51B5');
        button.addEventListener('click', () => {
            newHighlightActive = !newHighlightActive;
            if (newHighlightActive) {
                const n = applyNewHighlight();
                button.textContent = 'Mới ✓';
                button.style.backgroundColor = '#3949AB';
                showNotification(`${n} cụm có chữ mới (chưa có trong kho)`, 'info');
            } else {
                clearNewHighlight();
                button.textContent = 'Mới';
                button.style.backgroundColor = '#5C6BC0';
            }
        });
        ensureButtonBar().appendChild(button);
    }

    /**
     * Find the next <i t> segment that is adjacent in the original Chinese:
     * only whitespace-only text nodes may sit between the two elements.
     * Punctuation, <br>, or any other element breaks adjacency (those exist
     * in the source text too).
     */
    function nextAdjacentSegment(el) {
        let n = el.nextSibling;
        while (n) {
            if (n.nodeType === Node.TEXT_NODE && !n.textContent.trim()) {
                n = n.nextSibling;
                continue;
            }
            if (n.nodeType === Node.ELEMENT_NODE && n.matches('i[t]')) return n;
            return null;
        }
        return null;
    }

    /**
     * Scan the rendered chapter for candidate phrases and auto-collect
     * them into the learning DB. A candidate is a segment whose phrase:
     *  - is at least 2 characters (single chars break the MT),
     *  - is NOT already collected (learn DB / story / global $X=X),
     *  - is made entirely of characters you already know (every char
     *    appears in some collected phrase).
     * Single-character segments get a rescue pass: a known single char is
     * merged with its adjacent all-known segments to form candidates —
     * BOTH directions are tried (prev+char AND char+next), so 你 between
     * 看到 and 了 yields both 看到你 and 你了 if each is all-known.
     * New phrases enter the learning queue; the budget decides when they
     * actually render as Chinese (from the next chapter load).
     */
    function scanAndCollect() {
        // The button must ALWAYS answer — an uncaught error here used to
        // look like "Scan does nothing".
        try {
            doScanAndCollect();
        } catch (e) {
            reportError('Scan thất bại', e);
        }
    }

    function doScanAndCollect() {
        const storageKey = getLocalStorageKeyFromURL();
        if (!storageKey) {
            showNotification('Could not determine localStorage key from URL', 'error');
            return;
        }

        const db = loadDB();
        const collected = new Set(Object.keys(db.phrases));
        [storageKey, GLOBAL_KEY].forEach(key => {
            parseStorageEntries(localStorage.getItem(key)).forEach(entry => {
                if (entry.isSelf && entry.left) collected.add(entry.left);
            });
        });

        const knownChars = new Set();
        collected.forEach(p => {
            for (const ch of p) knownChars.add(ch);
        });

        if (knownChars.size === 0) {
            showNotification('No known characters yet — add some phrases first', 'info');
            return;
        }

        const segText = el => (el.getAttribute('t') || '').trim();
        const allKnown = t => t && [...t].every(ch => knownChars.has(ch));
        // Merged phrases longer than this are clauses, not vocabulary.
        const MAX_MERGED_CHARS = 6;

        const candidates = new Set();
        const segments = [...document.querySelectorAll('i[t]')];

        // Pass 1: whole segments that qualify on their own.
        segments.forEach(el => {
            const t = segText(el);
            if (!t || collected.has(t) || !isMaterializable(t)) return;
            if (allKnown(t)) candidates.add(t);
        });

        // Pass 2: rescue known single-char segments by merging with their
        // adjacent known segments — BOTH the preceding and following one.
        const prevOf = new Map();
        segments.forEach(el => {
            const next = nextAdjacentSegment(el);
            if (next) prevOf.set(next, el);
        });

        const tryMerge = merged => {
            if (!merged || collected.has(merged) || candidates.has(merged)) return;
            if ([...merged].length > MAX_MERGED_CHARS || !allKnown(merged)) return;
            candidates.add(merged);
        };

        segments.forEach(el => {
            const t = segText(el);
            if ([...t].length !== 1 || !knownChars.has(t)) return;

            // Try both neighbours independently (not next-or-prev).
            const prev = prevOf.get(el);
            if (prev) tryMerge(segText(prev) + t);
            const next = nextAdjacentSegment(el);
            if (next) tryMerge(t + segText(next));
        });

        if (candidates.size === 0) {
            showNotification('Không tìm thấy cụm mới nào (biết hết chữ) trong chương này', 'info');
            return;
        }

        let added = 0;
        candidates.forEach(p => {
            if (dbAddPhrase(db, p)) added++;
        });
        const saved = saveDB(db);
        updatePanelStats();

        console.log('STV-Learn: scan collected', [...candidates].join(', '));
        if (!saved) {
            showNotification(`Tìm thấy ${added} cụm mới nhưng LƯU THẤT BẠI — xem Debug trong bảng Học`, 'error');
            return;
        }
        showNotification(`Đã thêm ${added} cụm mới vào DB học — bấm Áp dụng để hiển thị theo budget`, 'success');

        // Harvest hv/meaning for the new phrases from this chapter's
        // <i h= v=> attributes right away.
        annotateRenderedPhrases();
    }

    /**
     * Add keyboard shortcut (Ctrl+Shift+E) to extract localStorage
     */
    function addKeyboardShortcut() {
        document.addEventListener('keydown', (event) => {
            if (event.ctrlKey && event.shiftKey && event.key === 'E') {
                event.preventDefault();
                extractAndCopyLocalStorage();
            }
        });
    }

    /**
     * Add Chinese word to localStorage + learning DB
     */
    function addChineseToLocalStorage() {
        const storageKey = getLocalStorageKeyFromURL();
        if (!storageKey) {
            showNotification('Could not determine localStorage key from URL', 'error');
            return;
        }
        const zwInput = document.getElementById('zw');
        if (!zwInput) {
            showNotification('Could not find Chinese input field', 'error');
            return;
        }
        const chineseText = zwInput.value.trim();
        if (!chineseText) {
            showNotification('Please enter Chinese text first', 'error');
            return;
        }

        // Record in the learning DB (master store).
        const db = loadDB();
        const isNew = dbAddPhrase(db, chineseText);
        saveDB(db);
        updatePanelStats();

        let currentValue = localStorage.getItem(storageKey) || '';
        const newEntry = `$${chineseText}=${chineseText}`;

        let globalValue = localStorage.getItem(GLOBAL_KEY) || '';
        if (!globalValue.includes(newEntry)) {
            if (globalValue) {
                globalValue = globalValue.replace(/~\/\/~$/, '');
                globalValue += `~//~${newEntry}~//~`;
            } else {
                globalValue = `${newEntry}~//~`;
            }
            const globalEntries = globalValue.split('~//~').filter(entry => entry.trim());
            globalEntries.sort((a, b) => {
                const aMatch = a.match(/^\$(.+)=(.+)$/);
                const bMatch = b.match(/^\$(.+)=(.+)$/);
                if (aMatch && bMatch) return aMatch[1].length - bMatch[1].length;
                return a.length - b.length;
            });
            localStorage.setItem(GLOBAL_KEY, globalEntries.join('~//~') + '~//~');
        }

        if (currentValue.includes(newEntry)) {
            showNotification(
                isNew ? `"${chineseText}" added to learn DB (already in story)` : `"${chineseText}" already exists in this story!`,
                isNew ? 'success' : 'error'
            );
            return;
        }

        if (currentValue) {
            currentValue = currentValue.replace(/~\/\/~$/, '');
            currentValue += `~//~${newEntry}~//~`;
        } else {
            currentValue = `${newEntry}~//~`;
        }

        const allEntries = currentValue.split('~//~').filter(entry => entry.trim());
        allEntries.sort((a, b) => {
            const aMatch = a.match(/^\$(.+)=(.+)$/);
            const bMatch = b.match(/^\$(.+)=(.+)$/);
            if (aMatch && bMatch) return aMatch[1].length - bMatch[1].length;
            return a.length - b.length;
        });
        localStorage.setItem(storageKey, allEntries.join('~//~') + '~//~');

        const singleNote = !isMaterializable(chineseText)
            ? ' (1 ký tự: chỉ truyện này + Anki, không tự lan)'
            : '';
        showNotification(`Added "${chineseText}"${isNew ? ' (+learn DB)' : ''}${singleNote} — tải lại trang để hiển thị!`, 'success');
    }

    /**
     * Get pinyin for Chinese text using pinyin.js library
     */
    function getPinyin(chineseText) {
        try {
            if (typeof pinyin === 'undefined' || typeof pinyin.pinyin === 'undefined') {
                return '';
            }
            const result = pinyin.pinyin(chineseText, {
                toneType: 'symbol', // tone marks (mā)
                type: 'array',
                heteronym: true,
                segment: true,
                group: true
            });
            if (Array.isArray(result)) return result.join(' ');
            return result || '';
        } catch (error) {
            console.error('Error converting to pinyin:', error);
            return '';
        }
    }

    /**
     * Update pinyin when Chinese input changes
     */
    function updatePinyin() {
        const zwInput = document.getElementById('zw');
        const pinyinInput = document.getElementById('pinyin');
        if (!zwInput || !pinyinInput) return;
        const chineseText = zwInput.value.trim();
        pinyinInput.value = chineseText ? getPinyin(chineseText) : '';
    }

    /**
     * Pronounce the Chinese text in the #zw input
     */
    function speakChinese() {
        const zwInput = document.getElementById('zw');
        const text = zwInput ? zwInput.value.trim() : '';
        if (!text) {
            showNotification('Please enter Chinese text first', 'error');
            return;
        }
        speakText(text);
    }

    /**
     * Add pinyin row to nsbox
     */
    function addPinyinRow() {
        const nsbox = document.getElementById('nsbox');
        if (!nsbox) return;
        if (document.getElementById('pinyin')) return;

        const zwRow = Array.from(nsbox.querySelectorAll('.row')).find(row =>
            row.querySelector('#zw')
        );
        if (!zwRow) return;

        const pinyinRow = document.createElement('div');
        pinyinRow.className = 'row';
        pinyinRow.innerHTML = `
            <span style="display:inline-block;width:30px;color:white;font-size:12px;padding:6px;background:green;">py</span>
            <input class="col" style="padding:0;font-size: 12px;" id="pinyin" placeholder="Pinyin" readonly>
            <button class="btn btn-info" type="button" id="getPinyinBtn" style="font-size: 12px;"><i class="fas fa-language"></i></button>
            <button class="btn btn-warning" type="button" id="speakChineseBtn" style="font-size: 12px;" title="Pronounce Chinese word"><i class="fas fa-volume-up"></i></button>
        `;
        zwRow.parentNode.insertBefore(pinyinRow, zwRow.nextSibling);

        const getPinyinBtn = document.getElementById('getPinyinBtn');
        if (getPinyinBtn) getPinyinBtn.addEventListener('click', updatePinyin);

        const speakBtn = document.getElementById('speakChineseBtn');
        if (speakBtn) speakBtn.addEventListener('click', speakChinese);

        const zwInput = document.getElementById('zw');
        if (zwInput) {
            zwInput.addEventListener('input', updatePinyin);
            if (zwInput.value.trim()) updatePinyin();
        }
    }

    /**
     * Add button to the nsbox element
     */
    function addButtonToNsbox() {
        const nsbox = document.getElementById('nsbox');
        if (!nsbox) return;
        if (document.getElementById('addChineseBtn')) return;

        const zwRow = Array.from(nsbox.querySelectorAll('.row')).find(row =>
            row.querySelector('#zw')
        );

        if (zwRow) {
            const addButton = document.createElement('button');
            addButton.id = 'addChineseBtn';
            addButton.className = 'btn btn-success';
            addButton.type = 'button';
            addButton.style.fontSize = '12px';
            addButton.innerHTML = '<i class="fas fa-plus"></i> Add';
            addButton.title = 'Add Chinese word to localStorage';
            addButton.addEventListener('click', () => {
                try { addChineseToLocalStorage(); } catch (e) { reportError('Thêm từ thất bại', e); }
            });

            const searchButton = zwRow.querySelector('button[onclick*="googlesearch"]');
            if (searchButton) {
                searchButton.parentNode.insertBefore(addButton, searchButton.nextSibling);
            } else {
                zwRow.appendChild(addButton);
            }
        }

        addPinyinRow();
        addCapitalizeAllButton();
    }

    /**
     * Add a "Hoa Toàn Bộ" button next to the English "Dùng" button
     * (the one that calls addSuperName('el')).
     */
    function addCapitalizeAllButton() {
        if (document.getElementById('capitalizeEnglishBtn')) return;

        const dungBtn = document.querySelector('button[onclick="addSuperName(\'el\')"]');
        if (!dungBtn) return;

        const newBtn = document.createElement('button');
        newBtn.id = 'capitalizeEnglishBtn';
        newBtn.type = 'button';
        newBtn.textContent = 'Hoa Toàn Bộ';
        newBtn.style.float = 'right';
        newBtn.style.marginRight = '4px';

        // addSuperName('el','a') doesn't work, so title-case the input value
        // ourselves and then call the regular addSuperName('el').
        newBtn.addEventListener('click', () => {
            const englishInput = document.getElementById('addnameboxip4');
            if (!englishInput) {
                showNotification('Could not find English input field', 'error');
                return;
            }
            const value = englishInput.value.trim();
            if (!value) {
                showNotification('Please enter English text first', 'error');
                return;
            }
            englishInput.value = value
                .toLowerCase()
                .replace(/\b\p{L}/gu, ch => ch.toUpperCase());

            if (typeof addSuperName === 'function') {
                addSuperName('el');
            } else {
                showNotification('addSuperName function not available', 'error');
            }
        });

        // Insert before the Dùng button so they sit side-by-side
        dungBtn.parentNode.insertBefore(newBtn, dungBtn);
    }

    /**
     * Monitor for nsbox element and add button when it appears
     */
    function monitorForNsbox() {
        addButtonToNsbox();
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        if (node.id === 'nsbox' || node.querySelector('#nsbox')) {
                            addButtonToNsbox();
                        }
                    }
                });
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setInterval(addButtonToNsbox, 1000);
    }

    /**
     * Initialize the script
     */
    function init() {
        // document-start: record storage state for the debug row. Story
        // storage is only ever written on user command (Áp dụng / add
        // buttons) — automatic writes raced the site's late content load
        // on mobile and clobbered manual additions.
        try {
            recordStorageProbe();
            localStorage.removeItem('STV_ACTIVE_CACHE'); // legacy auto-apply cache
        } catch (e) {
            reportError('Khởi tạo thất bại', e);
        }

        const start = () => {
            injectStyles();
            addRunButton();
            addScanButton();
            addNewHighlightButton();
            addLearnButton();
            addKeyboardShortcut();
            setupTooltipDelegation();
            monitorForNsbox();
            watchForChapterContent(); // renders keeps directly into the DOM

            loadPinyinLibrary().catch(err => console.error('Could not load pinyin library:', err));
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start);
        } else {
            start();
        }

        console.log('STV Chinese Learning Companion v2 loaded.');
    }

    init();

})();
