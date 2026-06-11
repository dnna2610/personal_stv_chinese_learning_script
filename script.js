// ==UserScript==
// @name         STV Chinese Learning Companion
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Learn Chinese while reading: density-budgeted kept phrases, SRS rotation, pinyin/Hán-Việt/audio tooltips, Anki export
// @author       You
// @match        https://sangtacviet.com/truyen/*/*
// @match        https://sangtacviet.vip/truyen/*/*
// @match        https://sangtacviet.vn/truyen/*/*
// @include      /^https?:\/\/sangtacviet\.[a-z]+\/truyen\/.*$/
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
                    if (!Array.isArray(db.settings.disabledStories)) db.settings.disabledStories = [];
                    return db;
                }
            }
        } catch (e) {
            console.error('STV-Learn: failed to parse DB, starting fresh', e);
        }
        return {
            version: 1,
            settings: { budget: DEFAULT_BUDGET, autoApply: true, disabledStories: [] },
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
        const active = new Set([...known, ...learningActive]);

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
        updatePanelStats(Object.keys(counts).length);
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
            <label class="stv-panel-row">
                <input type="checkbox" id="stv-story-toggle" ${storyDisabled ? '' : 'checked'}>
                Bật học cho truyện này
            </label>
            <div class="stv-panel-row stv-panel-buttons">
                <button id="stv-import-btn" title="Nhập mọi $X=X từ kho cũ vào DB học">Nhập từ kho cũ</button>
                <button id="stv-export-btn" title="Copy TSV (chữ, pinyin, Hán Việt, nghĩa) để import vào Anki">Xuất Anki</button>
            </div>
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

        panelEl.querySelector('#stv-story-toggle').addEventListener('change', e => {
            const key = getLocalStorageKeyFromURL();
            if (!key) return;
            const db2 = loadDB();
            const list = db2.settings.disabledStories;
            if (e.target.checked) {
                db2.settings.disabledStories = list.filter(k => k !== key);
            } else if (!list.includes(key)) {
                list.push(key);
            }
            saveDB(db2);
            showNotification(e.target.checked
                ? 'Bật học cho truyện này (từ chương kế)'
                : 'Tắt học cho truyện này — dùng Wipe để xoá chữ đang hiển thị', 'info');
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

        updatePanelStats();
        return panelEl;
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
        button.style.cssText = `
            position: fixed;
            bottom: 28px;
            right: 384px;
            padding: 10px 15px;
            background-color: #00897B;
            color: white;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-family: Arial, sans-serif;
            font-size: 14px;
            z-index: 10000;
            transition: background-color 0.3s ease;
        `;
        button.addEventListener('mouseover', () => { button.style.backgroundColor = '#00695C'; });
        button.addEventListener('mouseout', () => { button.style.backgroundColor = '#00897B'; });
        button.addEventListener('click', togglePanel);
        document.body.appendChild(button);
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
            #stv-learn-panel .stv-panel-buttons { display: flex; gap: 6px; }
            #stv-learn-panel .stv-panel-buttons button {
                flex: 1; background: #00897B; color: #fff; border: none;
                border-radius: 4px; padding: 6px 4px; cursor: pointer; font-size: 12px;
            }
            #stv-learn-panel .stv-panel-buttons button:hover { background: #00695C; }
            #stv-learn-panel .stv-panel-hint { color: #757575; font-size: 11px; }
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
     * Create and add run button to the page
     */
    function addRunButton() {
        const button = document.createElement('button');
        button.textContent = 'Chạy';
        button.style.cssText = `
            position: fixed;
            bottom: 28px;
            right: 80px;
            padding: 10px 15px;
            background-color: #2196F3;
            color: white;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-family: Arial, sans-serif;
            font-size: 14px;
            z-index: 10000;
            transition: background-color 0.3s ease;
        `;
        button.addEventListener('mouseover', () => { button.style.backgroundColor = '#1976D2'; });
        button.addEventListener('mouseout', () => { button.style.backgroundColor = '#2196F3'; });
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
        document.body.appendChild(button);
    }

    /**
     * Create and add merge button to the page
     */
    function addMergeButton() {
        const button = document.createElement('button');
        button.textContent = 'Merge';
        button.style.cssText = `
            position: fixed;
            bottom: 28px;
            right: 150px;
            padding: 10px 15px;
            background-color: #FF9800;
            color: white;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-family: Arial, sans-serif;
            font-size: 14px;
            z-index: 10000;
            transition: background-color 0.3s ease;
        `;
        button.addEventListener('mouseover', () => { button.style.backgroundColor = '#F57C00'; });
        button.addEventListener('mouseout', () => { button.style.backgroundColor = '#FF9800'; });
        button.addEventListener('click', mergeStorages);
        document.body.appendChild(button);
    }

    /**
     * Create and add scan toggle button to the page.
     * When active, highlights all <i t="..."> segments whose Chinese text
     * matches a "$X=X" entry in the current story's localStorage.
     */
    function addScanButton() {
        let isScanActive = false;
        const button = document.createElement('button');
        button.textContent = 'Scan';
        button.style.cssText = `
            position: fixed;
            bottom: 28px;
            right: 228px;
            padding: 10px 15px;
            background-color: #9C27B0;
            color: white;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-family: Arial, sans-serif;
            font-size: 14px;
            z-index: 10000;
            transition: background-color 0.3s ease;
        `;
        button.addEventListener('mouseover', () => {
            button.style.backgroundColor = isScanActive ? '#388E3C' : '#7B1FA2';
        });
        button.addEventListener('mouseout', () => {
            button.style.backgroundColor = isScanActive ? '#4CAF50' : '#9C27B0';
        });
        button.addEventListener('click', () => {
            if (!isScanActive) {
                const count = activateScanHighlight();
                if (count === null) return;
                isScanActive = true;
                button.textContent = 'Scan ✓';
                button.style.backgroundColor = '#4CAF50';
            } else {
                deactivateScanHighlight();
                isScanActive = false;
                button.textContent = 'Scan';
                button.style.backgroundColor = '#9C27B0';
            }
        });
        document.body.appendChild(button);
    }

    /**
     * Create and add the "Wipe" button, positioned to the left of Scan.
     * Removes all $X=X entries from the current story's storage AND
     * disables auto-apply for this story (otherwise the learning system
     * would re-add the active subset on the next chapter load).
     */
    function addWipeButton() {
        const button = document.createElement('button');
        button.textContent = 'Wipe';
        button.style.cssText = `
            position: fixed;
            bottom: 28px;
            right: 306px;
            padding: 10px 15px;
            background-color: #E53935;
            color: white;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-family: Arial, sans-serif;
            font-size: 14px;
            z-index: 10000;
            transition: background-color 0.3s ease;
        `;
        button.addEventListener('mouseover', () => { button.style.backgroundColor = '#C62828'; });
        button.addEventListener('mouseout', () => { button.style.backgroundColor = '#E53935'; });
        button.addEventListener('click', wipeChineseCharacters);
        document.body.appendChild(button);
    }

    /**
     * Highlight every <i t="..."> whose characters are all known —
     * from $X=X entries in this story OR from the learning DB (the budget
     * may have rotated entries out of story storage, but you still know them).
     */
    function activateScanHighlight() {
        const storageKey = getLocalStorageKeyFromURL();
        if (!storageKey) {
            showNotification('Could not determine localStorage key from URL', 'error');
            return null;
        }

        const knownChars = new Set();
        parseStorageEntries(localStorage.getItem(storageKey)).forEach(entry => {
            if (entry.isSelf && entry.left) {
                for (const ch of entry.left) knownChars.add(ch);
            }
        });
        const db = loadDB();
        Object.keys(db.phrases).forEach(p => {
            for (const ch of p) knownChars.add(ch);
        });

        if (knownChars.size === 0) {
            showNotification('No known characters in this story yet', 'info');
            return null;
        }

        let count = 0;
        document.querySelectorAll('i[t]').forEach(el => {
            const t = (el.getAttribute('t') || '').trim();
            if (!t) return;
            const chars = [...t];
            if (chars.length === 0) return;
            if (chars.every(ch => knownChars.has(ch))) {
                el.style.backgroundColor = pickHighlightColor(el);
                el.setAttribute('data-scan-highlighted', '1');
                count++;
            }
        });

        showNotification(`Highlighted ${count} known segment(s)`, 'success');
        return count;
    }

    /**
     * Pick a highlight background color that contrasts with the element's
     * current text color. Day mode (dark text) gets a vivid purple, night
     * mode (light text) gets a deeper indigo so white text stays readable.
     */
    function pickHighlightColor(el) {
        const color = getComputedStyle(el).color;
        const m = color.match(/\d+(\.\d+)?/g);
        if (!m || m.length < 3) {
            return '#893bff';
        }
        const r = parseFloat(m[0]);
        const g = parseFloat(m[1]);
        const b = parseFloat(m[2]);
        // Perceived luminance (0..1). >0.5 = light text → night mode.
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return luminance > 0.5 ? '#311B92' : '#893bff';
    }

    /**
     * Remove all highlights applied by activateScanHighlight().
     */
    function deactivateScanHighlight() {
        const nodes = document.querySelectorAll('i[data-scan-highlighted="1"]');
        nodes.forEach(el => {
            el.style.backgroundColor = '';
            el.removeAttribute('data-scan-highlighted');
        });
        return nodes.length;
    }

    /**
     * Remove all Chinese-character entries ("$X=X") from the current
     * story's localStorage, keeping every other entry. Also disables
     * auto-apply for this story so they stay gone.
     */
    function wipeChineseCharacters() {
        const storageKey = getLocalStorageKeyFromURL();
        if (!storageKey) {
            showNotification('Could not determine localStorage key from URL', 'error');
            return;
        }

        const currentValue = localStorage.getItem(storageKey);
        if (currentValue === null) {
            showNotification(`localStorage key "${storageKey}" not found`, 'error');
            return;
        }

        const entries = currentValue.split('~//~').filter(entry => entry.trim());
        const keptEntries = entries.filter(entry => {
            const match = entry.match(/^\$(.+)=(.+)$/);
            if (!match) return true;
            return match[1].trim() !== match[2].trim();
        });

        const removedCount = entries.length - keptEntries.length;
        if (removedCount === 0) {
            showNotification('No Chinese characters to wipe in this story', 'info');
            return;
        }

        if (!window.confirm(`Remove ${removedCount} Chinese character entr${removedCount === 1 ? 'y' : 'ies'} from this story? Learning auto-apply will be turned off for this story too.`)) {
            return;
        }

        const newValue = keptEntries.length > 0 ? keptEntries.join('~//~') + '~//~' : '';
        localStorage.setItem(storageKey, newValue);

        // Stop the learning system from re-adding them next chapter.
        const db = loadDB();
        if (!db.settings.disabledStories.includes(storageKey)) {
            db.settings.disabledStories.push(storageKey);
            saveDB(db);
        }

        showNotification(`Wiped ${removedCount} entr${removedCount === 1 ? 'y' : 'ies'}; learning off for this story (re-enable in Học panel)`, 'success');
    }

    /**
     * Merge characters between global and story storage
     */
    function mergeStorages() {
        const storageKey = getLocalStorageKeyFromURL();
        if (!storageKey) {
            showNotification('Could not determine localStorage key from URL', 'error');
            return;
        }

        const globalKey = GLOBAL_KEY;
        let globalValue = localStorage.getItem(globalKey) || '';
        let storyValue = localStorage.getItem(storageKey) || '';

        const globalEntries = globalValue.split('~//~').filter(entry => entry.trim());
        const storyEntries = storyValue.split('~//~').filter(entry => entry.trim());
        const globalSet = new Set(globalEntries);
        const storySet = new Set(storyEntries);

        let addedToGlobal = 0;
        let addedToStory = 0;

        storyEntries.forEach(entry => {
            if (!globalSet.has(entry)) {
                const match = entry.match(/^\$(.+)=(.+)$/);
                if (match && match[1].trim() === match[2].trim()) {
                    globalEntries.push(entry);
                    addedToGlobal++;
                }
            }
        });

        globalEntries.forEach(entry => {
            if (!storySet.has(entry)) {
                const match = entry.match(/^\$(.+)=(.+)$/);
                if (match && [...match[1].trim()].length <= 1) return;
                storyEntries.push(entry);
                addedToStory++;
            }
        });

        const sortByChineseLength = (a, b) => {
            const aMatch = a.match(/^\$(.+)=(.+)$/);
            const bMatch = b.match(/^\$(.+)=(.+)$/);
            if (aMatch && bMatch) return aMatch[1].length - bMatch[1].length;
            return a.length - b.length;
        };
        globalEntries.sort(sortByChineseLength);
        storyEntries.sort(sortByChineseLength);

        const uniqueGlobalEntries = [...new Set(globalEntries)];
        const uniqueStoryEntries = [...new Set(storyEntries)];

        localStorage.setItem(globalKey, uniqueGlobalEntries.length ? uniqueGlobalEntries.join('~//~') + '~//~' : '');
        localStorage.setItem(storageKey, uniqueStoryEntries.length ? uniqueStoryEntries.join('~//~') + '~//~' : '');

        // Keep the learning DB in sync with anything merged.
        const db = loadDB();
        const n = importFromNameStorages(db);
        saveDB(db);

        showNotification(`Merged! +${addedToGlobal} global, +${addedToStory} story${n ? `, +${n} learn DB` : ''}`, 'success');
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
            addMergeButton();
            addScanButton();
            addWipeButton();
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
