// ==UserScript==
// @name         STV Chinese Learning Companion
// @namespace    http://tampermonkey.net/
// @version      2.0
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
    // Learning DB
    //
    // Master vocabulary store, independent of the site's per-story name
    // storages. The story storage is treated as a render target: at every
    // page load (document-start, before the site reads its name list) a
    // budgeted subset of phrases is materialized into it as $X=X entries.
    // The site then renders the chapter with exactly that subset — names
    // take effect on chapter load, which is the site's native behavior.
    //
    // Shape:
    // {
    //   version: 1,
    //   settings: { budget: 15, autoApply: true, disabledStories: [] },
    //   phrases: {
    //     "修炼": { added: "2026-06-11", status: "learning"|"known",
    //               exposures: 0, lapses: 0, lastSeen: "2026-06-11"|null,
    //               hv: "tu luyện", meaning: "tu luyện/rèn luyện" }
    //   }
    // }
    // hv/meaning are harvested automatically from the site's own
    // <i h="..." v="..."> attributes the first time a phrase is seen.
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
                    if (typeof db.settings.autoApply !== 'boolean') db.settings.autoApply = true;
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
            settings: { budget: DEFAULT_BUDGET, autoApply: true, showKnown: true, disabledStories: [] },
            phrases: {}
        };
    }

    function saveDB(db) {
        localStorage.setItem(DB_KEY, JSON.stringify(db));
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
     * Import every $X=X entry from the global store and the current story's
     * store into the learning DB (as "learning"). Returns count added.
     */
    function importFromNameStorages(db) {
        let added = 0;
        const sources = [localStorage.getItem(GLOBAL_KEY)];
        const storyKey = getLocalStorageKeyFromURL();
        if (storyKey) sources.push(localStorage.getItem(storyKey));

        sources.forEach(value => {
            parseStorageEntries(value).forEach(entry => {
                if (entry.isSelf && dbAddPhrase(db, entry.left)) added++;
            });
        });
        return added;
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
    function selectActivePhrases(db) {
        const known = [];
        const learning = [];
        let singles = 0;
        Object.entries(db.phrases).forEach(([phrase, info]) => {
            if (!isMaterializable(phrase)) { singles++; return; }
            if (info.status === 'known') known.push(phrase);
            else learning.push(phrase);
        });

        learning.sort((a, b) => {
            const ia = db.phrases[a], ib = db.phrases[b];
            const seenA = ia.lastSeen || '';
            const seenB = ib.lastSeen || '';
            if (seenA !== seenB) return seenA < seenB ? -1 : 1; // '' (never) first
            return ia.exposures - ib.exposures;
        });

        return {
            known,
            learningActive: learning.slice(0, db.settings.budget),
            learningTotal: learning.length,
            singles
        };
    }

    // =====================================================================
    // Auto-apply: materialize the active subset into the story storage.
    // Runs at document-start so the site's name loader sees the subset.
    // =====================================================================

    /**
     * Rewrite the current story's storage so that:
     *  - real translation names ($X=Y, X≠Y) are kept untouched
     *  - $X=X entries appear only for the active phrase set
     *  - active phrases get $X=X added even if this story never had them
     *    (your vocabulary follows you into every story)
     *  - an explicit translation $X=Y for an active X wins over $X=X
     * Returns stats or null when skipped.
     */
    function applyBudgetToStoryStorage() {
        const storyKey = getLocalStorageKeyFromURL();
        if (!storyKey) return null;

        const db = loadDB();
        if (!db.settings.autoApply) return null;
        if (db.settings.disabledStories.includes(storyKey)) return null;

        // Pick up phrases added through the site dialog last chapter.
        const imported = importFromNameStorages(db);

        const { known, learningActive, learningTotal } = selectActivePhrases(db);
        const active = new Set([
            ...(db.settings.showKnown ? known : []),
            ...learningActive
        ]);

        const entries = parseStorageEntries(localStorage.getItem(storyKey));
        // Keep real translations, and keep single-char $X=X the user added
        // to THIS story deliberately (they are story-local, never propagated).
        const keep = entries.filter(e =>
            !e.isSelf || (e.left && !isMaterializable(e.left))
        );
        const explicitLefts = new Set(keep.map(e => e.left).filter(Boolean));

        const selfEntries = [...active]
            .filter(p => !explicitLefts.has(p))
            .map(p => ({ raw: `$${p}=${p}`, left: p }));

        const all = [...keep, ...selfEntries];
        // Site convention: sort by Chinese length ascending.
        all.sort((a, b) => {
            const la = a.left ? a.left.length : a.raw.length;
            const lb = b.left ? b.left.length : b.raw.length;
            return la - lb;
        });

        const newValue = all.length ? all.map(e => e.raw).join('~//~') + '~//~' : '';
        localStorage.setItem(storyKey, newValue);
        saveDB(db);

        return {
            active: active.size,
            learningActive: learningActive.length,
            learningTotal,
            known: known.length,
            imported
        };
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

            // Harvest Hán-Việt + meaning from the site's own attributes,
            // even for segments currently rendered as Vietnamese.
            const h = (el.getAttribute('h') || '').trim();
            const v = (el.getAttribute('v') || '').trim();
            if (h && !info.hv) { info.hv = h; dirty = true; }
            if (v && !info.meaning) { info.meaning = v; dirty = true; }

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
            timer = setTimeout(annotateRenderedPhrases, 1500);
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
        const meaningRaw = (el.getAttribute('v') || info.meaning || '').trim();
        const meanings = [...new Set(meaningRaw.split('/').filter(Boolean))].slice(0, 3).join(' · ');
        const statusLabel = info.status === 'known' ? 'Đã thuộc' : 'Đang học';
        const suggest = info.status === 'learning' && info.exposures >= PROMOTE_SUGGEST_AT;

        tip.innerHTML = `
            <span class="stv-tip-close" title="Đóng">✕</span>
            <div class="stv-tip-phrase">${phrase}</div>
            <div class="stv-tip-pinyin">${py}</div>
            ${hv ? `<div class="stv-tip-hv">HV: ${hv}</div>` : ''}
            ${meanings ? `<div class="stv-tip-meaning">${meanings}</div>` : ''}
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
            showNotification(`"${phrase}" → đã thuộc. Slot trống cho từ mới!`, 'success');
        } else if (action === 'demote') {
            info.status = 'learning';
            showNotification(`"${phrase}" → học lại`, 'info');
        } else if (action === 'lapse') {
            info.lapses++;
            info.lastSeen = null; // jump the queue at next chapter load
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
    // Anki export
    // =====================================================================

    /**
     * Copy the whole DB as TSV, ready for Anki import (tab-separated):
     * phrase, pinyin, hán việt, meaning, status, exposures, added
     */
    async function exportAnkiTSV() {
        const db = loadDB();
        const rows = Object.entries(db.phrases).map(([phrase, info]) => {
            const py = getPinyin(phrase).replace(/\t/g, ' ');
            const meaning = (info.meaning || '').replace(/\t/g, ' ');
            return [phrase, py, info.hv || '', meaning, info.status, info.exposures, info.added].join('\t');
        });
        if (!rows.length) {
            showNotification('No phrases in learning DB yet', 'error');
            return;
        }
        const ok = await copyToClipboard(rows.join('\n'));
        showNotification(ok ? `Copied ${rows.length} phrases as TSV` : 'Failed to copy', ok ? 'success' : 'error');
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
                <button id="stv-import-btn" title="Nhập mọi $X=X từ kho cũ vào DB học">Nhập từ kho cũ</button>
                <button id="stv-export-btn" title="Copy TSV (chữ, pinyin, Hán Việt, nghĩa) để import vào Anki">Xuất Anki</button>
            </div>
            <div class="stv-panel-row" id="stv-chapter-overview"></div>
            <div class="stv-panel-hint">Thay đổi có hiệu lực từ chương kế (như cơ chế name của site). Mệt thì kéo slider xuống.</div>
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
            showNotification(`Budget: ${slider.value} cụm — hiệu lực từ chương kế`, 'info');
            updatePanelStats();
        });

        const manualInput = panelEl.querySelector('#stv-manual-input');
        const submitManual = () => {
            const value = manualInput.value.trim();
            if (!value) return;
            const added = learnAddPhrase(value);
            manualInput.value = '';
            updatePanelStats();
            refreshNewHighlight();
            const singleNote = !isMaterializable(value) ? ' (1 ký tự: chỉ Anki + nhận diện)' : '';
            showNotification(added
                ? `Đã thêm "${value}"${singleNote} — hiệu lực từ chương kế`
                : `"${value}" đã có trong kho`, added ? 'success' : 'info');
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
                ? 'Cụm đã thuộc sẽ hiển thị (từ chương kế)'
                : 'Ẩn cụm đã thuộc — slider 0 = tắt hẳn (từ chương kế)', 'info');
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
                ? 'Bật học cho truyện này (từ chương kế)'
                : 'Tắt học cho truyện này — chữ Trung sẽ biến mất từ chương kế', 'info');
        });

        panelEl.querySelector('#stv-panel-close').addEventListener('click', togglePanel);
        panelEl.querySelector('#stv-import-btn').addEventListener('click', () => {
            const db2 = loadDB();
            const n = importFromNameStorages(db2);
            saveDB(db2);
            showNotification(`Imported ${n} new phrase(s) into learning DB`, n ? 'success' : 'info');
            updatePanelStats();
        });
        panelEl.querySelector('#stv-export-btn').addEventListener('click', exportAnkiTSV);

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
        return panelEl;
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
        let learningCount = 0;
        let knownCount = 0;

        // Most frequent first; learning before known within equal counts.
        phrases.sort((a, b) => lastChapterCounts[b] - lastChapterCounts[a]);

        const chips = phrases.map(p => {
            const info = db.phrases[p];
            const isKnown = info && info.status === 'known';
            if (isKnown) knownCount++; else learningCount++;
            return `<span class="stv-chip ${isKnown ? 'stv-chip-known' : 'stv-chip-learning'}" data-phrase="${p}" title="Bấm để nhảy tới">${p} <small>×${lastChapterCounts[p]}</small></span>`;
        }).join('');

        container.innerHTML = `
            <div class="stv-overview-title">Chương này: <b>${phrases.length}</b> cụm (${learningCount} đang học, ${knownCount} đã thuộc) · <b>${totalOccurrences}</b> lần xuất hiện</div>
            <div class="stv-overview-chips">${chips}</div>
        `;
    }

    function updatePanelStats(annotatedCount) {
        if (!panelEl) return;
        const db = loadDB();
        const { known, learningActive, learningTotal, singles } = selectActivePhrases(db);
        const statsEl = panelEl.querySelector('#stv-panel-stats');
        if (statsEl) {
            statsEl.innerHTML =
                `Đang học: <b>${learningTotal}</b> (hiển thị ${learningActive.length})` +
                ` · Đã thuộc: <b>${known.length}</b>` +
                (singles ? ` · 1 ký tự: <b>${singles}</b> (chỉ Anki)` : '') +
                (typeof annotatedCount === 'number' ? ` · Trong chương: <b>${annotatedCount}</b>` : '');
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
    function showNotification(message, type = 'info') {
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
     * added. Harvests Hán-Việt + meaning from any matching rendered
     * segment so manual adds get enriched immediately.
     */
    function learnAddPhrase(phrase) {
        phrase = (phrase || '').trim();
        if (!phrase) return false;
        const db = loadDB();
        const added = dbAddPhrase(db, phrase);
        // Enrich from a rendered segment if present.
        const seg = [...document.querySelectorAll('i[t]')].find(el =>
            (el.getAttribute('t') || '').trim() === phrase
        );
        if (seg) {
            const info = db.phrases[phrase];
            const h = (seg.getAttribute('h') || '').trim();
            const v = (seg.getAttribute('v') || '').trim();
            if (h && !info.hv) info.hv = h;
            if (v && !info.meaning) info.meaning = v;
        }
        saveDB(db);
        return added;
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
     * merged with an adjacent all-known segment to form a candidate
     * (我 + 就是 → 我就是, or 就 + 是 → 就是), preferring the following
     * segment, falling back to the preceding one.
     * New phrases enter the learning queue; the budget decides when they
     * actually render as Chinese (from the next chapter load).
     */
    function scanAndCollect() {
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

        // Pass 2: rescue known single-char segments by merging with an
        // adjacent known segment (next preferred, then previous).
        const prevOf = new Map();
        segments.forEach(el => {
            const next = nextAdjacentSegment(el);
            if (next) prevOf.set(next, el);
        });

        segments.forEach(el => {
            const t = segText(el);
            if ([...t].length !== 1 || !knownChars.has(t)) return;

            const tryMerge = merged => {
                if (!merged || collected.has(merged) || candidates.has(merged)) return false;
                if ([...merged].length > MAX_MERGED_CHARS || !allKnown(merged)) return false;
                candidates.add(merged);
                return true;
            };

            const next = nextAdjacentSegment(el);
            if (next && tryMerge(t + segText(next))) return;
            const prev = prevOf.get(el);
            if (prev) tryMerge(segText(prev) + t);
        });

        if (candidates.size === 0) {
            showNotification('Không tìm thấy cụm mới nào (biết hết chữ) trong chương này', 'info');
            return;
        }

        let added = 0;
        candidates.forEach(p => {
            if (dbAddPhrase(db, p)) added++;
        });
        saveDB(db);
        updatePanelStats();

        console.log('STV-Learn: scan collected', [...candidates].join(', '));
        showNotification(`Đã thêm ${added} cụm mới vào DB học — hiệu lực từ chương kế`, 'success');

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
        showNotification(`Added "${chineseText}"${isNew ? ' (+learn DB)' : ''}${singleNote} — hiệu lực từ chương kế!`, 'success');
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
            addButton.addEventListener('click', addChineseToLocalStorage);

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
        // FIRST, before the site reads its name list: materialize the
        // budgeted learning subset into this story's storage. Pure
        // localStorage work — safe at document-start.
        let applyStats = null;
        try {
            applyStats = applyBudgetToStoryStorage();
        } catch (e) {
            console.error('STV-Learn: auto-apply failed', e);
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
            watchForChapterContent();

            loadPinyinLibrary().catch(err => console.error('Could not load pinyin library:', err));

            if (applyStats) {
                showNotification(
                    `Học: ${applyStats.active} cụm (${applyStats.learningActive}/${applyStats.learningTotal} đang học + ${applyStats.known} đã thuộc)` +
                    (applyStats.imported ? ` · nhập ${applyStats.imported} mới` : ''),
                    'info'
                );
            }
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
