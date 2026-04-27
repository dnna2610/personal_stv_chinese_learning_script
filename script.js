// ==UserScript==
// @name         LocalStorage Value Extractor
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Extract localStorage values and copy to clipboard
// @author       You
// @match        https://sangtacviet.com/truyen/*/*
// @match        https://sangtacviet.vip/truyen/*/*
// @match        https://sangtacviet.vn/truyen/*/*
// @include      /^https?:\/\/sangtacviet\.[a-z]+\/truyen\/.*$/
// @require      https://cdn.jsdelivr.net/npm/pinyin@4.0.0/lib/umd/pinyin.min.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    /**
     * Load pinyin library dynamically
     */
    function loadPinyinLibrary() {
        return new Promise((resolve, reject) => {
            // Check if already loaded
            if (typeof pinyin !== 'undefined') {
                resolve();
                return;
            }

            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/pinyin@4.0.0/lib/umd/pinyin.min.js';
            script.crossOrigin = 'anonymous';
            script.onload = () => {
                console.log('Pinyin library loaded successfully');
                resolve();
            };
            script.onerror = () => {
                console.error('Failed to load pinyin library');
                reject(new Error('Failed to load pinyin library'));
            };
            document.head.appendChild(script);
        });
    }

    /**
     * Extract localStorage key pattern from URL
     * For URL: https://sangtacviet.com/truyen/qidian/1/1046597676/864072902/
     * Returns: "qidian1046597676"
     * For URL: https://sangtacviet.com/truyen/fanqie/1/7540232796476820504/7540232952710431256/
     * Returns: "fanqie7540232796476820504"
     */
    function getLocalStorageKeyFromURL() {
        const url = window.location.pathname;
        const pathParts = url.split('/');

        // Expected pattern: /truyen/{platform}/[something]/[id]/[chapter]/
        if (pathParts.length >= 5 && pathParts[1] === 'truyen') {
            const platform = pathParts[2]; // "qidian", "fanqie", etc.
            const id = pathParts[4]; // "1046597676", "7540232796476820504", etc.
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
                // Modern Clipboard API
                await navigator.clipboard.writeText(text);
                return true;
            } else {
                // Fallback for older browsers or non-secure contexts
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
     * Extract localStorage value and copy to clipboard
     */
    async function extractAndCopyLocalStorage() {
        const storageKey = getLocalStorageKeyFromURL();

        if (!storageKey) {
            console.log('Could not determine localStorage key from URL');
            showNotification('Could not determine localStorage key from URL', 'error');
            return;
        }

        const storageValue = localStorage.getItem(storageKey);

        if (storageValue === null) {
            console.log(`localStorage key "${storageKey}" not found`);
            showNotification(`localStorage key "${storageKey}" not found`, 'error');
            return;
        }

        // Split the value on "~//~" and filter for Chinese character entries only
        const entries = storageValue.split('~//~').filter(entry => entry.trim());

        // Filter for entries that match the pattern "$chinese=chinese" (same characters on both sides)
        const chineseEntries = entries.filter(entry => {
            const match = entry.match(/^\$(.+)=(.+)$/);
            if (match) {
                const leftSide = match[1].trim();
                const rightSide = match[2].trim();
                // Only include entries where both sides are identical (Chinese characters)
                return leftSide === rightSide;
            }
            return false;
        });

        // Remove duplicates by converting to Set and back to array
        const uniqueEntries = [...new Set(chineseEntries)];

        // Sort entries by length of the Chinese text (left side of =)
        uniqueEntries.sort((a, b) => {
            const aMatch = a.match(/^\$(.+)=(.+)$/);
            const bMatch = b.match(/^\$(.+)=(.+)$/);
            if (aMatch && bMatch) {
                return aMatch[1].length - bMatch[1].length;
            }
            return a.length - b.length; // fallback to total length
        });

        const formattedValue = uniqueEntries.join('\n');

        const success = await copyToClipboard(formattedValue);

        if (success) {
            console.log(`Copied localStorage["${storageKey}"] to clipboard:`, formattedValue);
            showNotification(`Copied "${storageKey}" to clipboard!`, 'success');
        } else {
            console.error('Failed to copy to clipboard');
            showNotification('Failed to copy to clipboard', 'error');
        }
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

        // Set color based on type
        switch (type) {
            case 'success':
                notification.style.backgroundColor = '#4CAF50';
                break;
            case 'error':
                notification.style.backgroundColor = '#f44336';
                break;
            default:
                notification.style.backgroundColor = '#2196F3';
        }

        document.body.appendChild(notification);

        // Fade in
        setTimeout(() => {
            notification.style.opacity = '1';
        }, 10);

        // Fade out and remove after 3 seconds
        setTimeout(() => {
            notification.style.opacity = '0';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
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

        button.addEventListener('mouseover', () => {
            button.style.backgroundColor = '#1976D2';
        });

        button.addEventListener('mouseout', () => {
            button.style.backgroundColor = '#2196F3';
        });

        button.addEventListener('click', () => {
            try {
                // Call the same functions as the original "Chạy" button
                if (typeof saveNS === 'function') {
                    saveNS();
                }
                if (typeof excute === 'function') {
                    excute();
                }
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

        button.addEventListener('mouseover', () => {
            button.style.backgroundColor = '#F57C00';
        });

        button.addEventListener('mouseout', () => {
            button.style.backgroundColor = '#FF9800';
        });

        button.addEventListener('click', mergeStorages);

        document.body.appendChild(button);
    }

    /**
     * Create and add scan toggle button to the page.
     * When active, highlights all <i t="..."> segments whose Chinese text
     * matches a "$X=X" entry in the current story's localStorage.
     * Click again to remove the highlights.
     *
     * Note: only re-scans when toggled. If new content loads while active,
     * toggle off and on again to re-scan.
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
                if (count === null) {
                    // Error or no-op: keep the button inactive.
                    return;
                }
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
     * Highlight every <i t="..."> whose `t` (trimmed) matches a known
     * "$X=X" entry in the current story's localStorage.
     * Returns the count of highlighted nodes, or null if it bailed out
     * (no story key, no storage value, or no known entries to match).
     */
    function activateScanHighlight() {
        const storageKey = getLocalStorageKeyFromURL();
        if (!storageKey) {
            showNotification('Could not determine localStorage key from URL', 'error');
            return null;
        }

        const raw = localStorage.getItem(storageKey);
        if (!raw) {
            showNotification(`localStorage key "${storageKey}" not found`, 'error');
            return null;
        }

        // Build the set of known Chinese characters — pulled per-character
        // from any "$X=X" entry's left side. So if the user has added either
        // "$了=了" or a phrase like "$阿根廷=阿根廷", each individual character
        // (了, 阿, 根, 廷) is treated as known.
        const knownChars = new Set();
        raw.split('~//~').forEach(entry => {
            if (!entry.trim()) return;
            const m = entry.match(/^\$(.+)=(.+)$/);
            if (!m) return;
            const left = m[1].trim();
            const right = m[2].trim();
            if (left && left === right) {
                for (const ch of left) {
                    knownChars.add(ch);
                }
            }
        });

        if (knownChars.size === 0) {
            showNotification('No known characters in this story yet', 'info');
            return null;
        }

        let count = 0;
        document.querySelectorAll('i[t]').forEach(el => {
            const t = (el.getAttribute('t') || '').trim();
            if (!t) return;
            // Highlight only when every character in `t` is individually known.
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
     * Merge characters between global and story storage
     */
    function mergeStorages() {
        const storageKey = getLocalStorageKeyFromURL();

        if (!storageKey) {
            console.log('Could not determine localStorage key from URL');
            showNotification('Could not determine localStorage key from URL', 'error');
            return;
        }

        const globalKey = 'CHINESE_CHARACTERS';
        let globalValue = localStorage.getItem(globalKey) || '';
        let storyValue = localStorage.getItem(storageKey) || '';

        // Get all entries from both storages
        const globalEntries = globalValue.split('~//~').filter(entry => entry.trim());
        const storyEntries = storyValue.split('~//~').filter(entry => entry.trim());

        // Create sets for quick lookup
        const globalSet = new Set(globalEntries);
        const storySet = new Set(storyEntries);

        let addedToGlobal = 0;
        let addedToStory = 0;

        // Add story entries to global if not present (only same-character entries)
        storyEntries.forEach(entry => {
            if (!globalSet.has(entry)) {
                // Only add entries where left side equals right side (Chinese characters)
                const match = entry.match(/^\$(.+)=(.+)$/);
                if (match) {
                    const leftSide = match[1].trim();
                    const rightSide = match[2].trim();
                    if (leftSide === rightSide) {
                        globalEntries.push(entry);
                        addedToGlobal++;
                    }
                }
            }
        });

        // Add global entries to story if not present (skip single-character entries)
        globalEntries.forEach(entry => {
            if (!storySet.has(entry)) {
                const match = entry.match(/^\$(.+)=(.+)$/);
                if (match) {
                    const leftSide = match[1].trim();
                    // Skip single-character entries from global to story
                    if ([...leftSide].length <= 1) {
                        return;
                    }
                }
                storyEntries.push(entry);
                addedToStory++;
            }
        });

        // Sort global storage by length of Chinese text (left side of =)
        globalEntries.sort((a, b) => {
            const aMatch = a.match(/^\$(.+)=(.+)$/);
            const bMatch = b.match(/^\$(.+)=(.+)$/);
            if (aMatch && bMatch) {
                return aMatch[1].length - bMatch[1].length;
            }
            return a.length - b.length; // fallback to total length
        });

        // Sort story storage by length of Chinese text (left side of =)
        storyEntries.sort((a, b) => {
            const aMatch = a.match(/^\$(.+)=(.+)$/);
            const bMatch = b.match(/^\$(.+)=(.+)$/);
            if (aMatch && bMatch) {
                return aMatch[1].length - bMatch[1].length;
            }
            return a.length - b.length; // fallback to total length
        });

        // Ensure both storages have unique entries
        const uniqueGlobalEntries = [...new Set(globalEntries)];
        const uniqueStoryEntries = [...new Set(storyEntries)];

        // Update both storages
        const newGlobalValue = uniqueGlobalEntries.length > 0 ? uniqueGlobalEntries.join('~//~') + '~//~' : '';
        const newStoryValue = uniqueStoryEntries.length > 0 ? uniqueStoryEntries.join('~//~') + '~//~' : '';

        localStorage.setItem(globalKey, newGlobalValue);
        localStorage.setItem(storageKey, newStoryValue);

        // Show notification
        const message = `Merged! Added ${addedToGlobal} to global, ${addedToStory} to story`;
        console.log(message);
        showNotification(message, 'success');
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
     * Add Chinese word to localStorage
     */
    function addChineseToLocalStorage() {
        const storageKey = getLocalStorageKeyFromURL();

        if (!storageKey) {
            console.log('Could not determine localStorage key from URL');
            showNotification('Could not determine localStorage key from URL', 'error');
            return;
        }

        const zwInput = document.getElementById('zw');
        if (!zwInput) {
            console.log('Could not find zw input element');
            showNotification('Could not find Chinese input field', 'error');
            return;
        }

        const chineseText = zwInput.value.trim();
        if (!chineseText) {
            console.log('Chinese input is empty');
            showNotification('Please enter Chinese text first', 'error');
            return;
        }

        // Get current localStorage value
        let currentValue = localStorage.getItem(storageKey) || '';

        // Create new entry in format "$chinese=chinese"
        const newEntry = `$${chineseText}=${chineseText}`;

        // First, add to global CHINESE_CHARACTERS key
        const globalKey = 'CHINESE_CHARACTERS';
        let globalValue = localStorage.getItem(globalKey) || '';

        // Check if the entry already exists in global storage
        if (!globalValue.includes(newEntry)) {
            // Add to global localStorage with proper delimiter handling
            if (globalValue) {
                globalValue = globalValue.replace(/~\/\/~$/, '');
                globalValue += `~//~${newEntry}~//~`;
            } else {
                globalValue = `${newEntry}~//~`;
            }

            // Sort global entries by length of Chinese text (left side of =)
            const globalEntries = globalValue.split('~//~').filter(entry => entry.trim());
            globalEntries.sort((a, b) => {
                const aMatch = a.match(/^\$(.+)=(.+)$/);
                const bMatch = b.match(/^\$(.+)=(.+)$/);
                if (aMatch && bMatch) {
                    return aMatch[1].length - bMatch[1].length;
                }
                return a.length - b.length; // fallback to total length
            });

            globalValue = globalEntries.join('~//~') + '~//~';
            localStorage.setItem(globalKey, globalValue);
            console.log(`Added "${newEntry}" to global localStorage["${globalKey}"]`);
        }

        // Then, add to story-specific localStorage
        // Check if the entry already exists in story-specific storage
        if (currentValue.includes(newEntry)) {
            console.log(`Entry "${newEntry}" already exists in localStorage`);
            showNotification(`"${chineseText}" already exists in this story!`, 'error');
            return;
        }

        // Add to localStorage with proper delimiter handling
        if (currentValue) {
            // Remove trailing ~//~ if it exists, then add the new entry with delimiter
            currentValue = currentValue.replace(/~\/\/~$/, '');
            currentValue += `~//~${newEntry}~//~`;
        } else {
            currentValue = `${newEntry}~//~`;
        }

        // Sort all entries by length of Chinese text (left side of =)
        const allEntries = currentValue.split('~//~').filter(entry => entry.trim());

        // Sort entries by length of Chinese text (left side of =)
        allEntries.sort((a, b) => {
            const aMatch = a.match(/^\$(.+)=(.+)$/);
            const bMatch = b.match(/^\$(.+)=(.+)$/);
            if (aMatch && bMatch) {
                return aMatch[1].length - bMatch[1].length;
            }
            return a.length - b.length; // fallback to total length
        });

        // Rebuild the localStorage value with sorted entries
        currentValue = allEntries.join('~//~') + '~//~';

        localStorage.setItem(storageKey, currentValue);

        console.log(`Added "${newEntry}" to localStorage["${storageKey}"]`);
        showNotification(`Added "${chineseText}" to localStorage!`, 'success');
    }

    /**
     * Get pinyin for Chinese text using pinyin.js library
     */
    function getPinyin(chineseText) {
        try {
            // Check if pinyin library is loaded
            if (typeof pinyin === 'undefined' || typeof pinyin.pinyin === 'undefined') {
                console.error('Pinyin library not loaded');
                return 'Library not loaded';
            }

            console.log('Converting to pinyin:', chineseText);
            console.log('Pinyin object:', pinyin);

            // Convert to pinyin with tone marks
            // For pinyin v4.0.0 UMD build, the API is: pinyin.pinyin(text, options)
            const result = pinyin.pinyin(chineseText, {
                toneType: 'symbol', // 'symbol' for tone marks (mā), 'num' for numbers (ma1), 'none' for no tones
                type: 'array', // Return as array,
                heteronym: true,
                segment: true,
                group: true
            });

            console.log('Pinyin result:', result);

            // Join the result into a single string
            if (Array.isArray(result)) {
                return result.join(' ');
            }

            return result || '';
        } catch (error) {
            console.error('Error converting to pinyin:', error);
            return 'Error: ' + error.message;
        }
    }

    /**
     * Update pinyin when Chinese input changes
     */
    function updatePinyin() {
        console.log('updatePinyin called');
        const zwInput = document.getElementById('zw');
        const pinyinInput = document.getElementById('pinyin');

        console.log('zwInput:', zwInput);
        console.log('pinyinInput:', pinyinInput);

        if (!zwInput || !pinyinInput) {
            console.log('Missing inputs, zwInput:', !!zwInput, 'pinyinInput:', !!pinyinInput);
            return;
        }

        const chineseText = zwInput.value.trim();
        console.log('Chinese text:', chineseText);

        if (!chineseText) {
            pinyinInput.value = '';
            return;
        }

        // Get pinyin using the library
        const pinyinResult = getPinyin(chineseText);
        console.log('Setting pinyin input to:', pinyinResult);
        pinyinInput.value = pinyinResult;
    }

    /**
     * Pronounce the Chinese text in the #zw input using the browser's speech synthesis
     */
    function speakChinese() {
        const zwInput = document.getElementById('zw');
        const text = zwInput ? zwInput.value.trim() : '';

        if (!text) {
            showNotification('Please enter Chinese text first', 'error');
            return;
        }

        if (!('speechSynthesis' in window)) {
            showNotification('Speech synthesis not supported in this browser', 'error');
            return;
        }

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'zh-CN';
        utterance.rate = 0.9;

        // Prefer a Chinese voice if one is installed
        const voices = speechSynthesis.getVoices();
        const zhVoice = voices.find(v => v.lang && v.lang.toLowerCase().startsWith('zh'));
        if (zhVoice) {
            utterance.voice = zhVoice;
        }

        speechSynthesis.cancel(); // stop anything currently speaking
        speechSynthesis.speak(utterance);
    }

    /**
     * Add pinyin row to nsbox
     */
    function addPinyinRow() {
        console.log('addPinyinRow called');
        const nsbox = document.getElementById('nsbox');
        if (!nsbox) {
            console.log('nsbox not found');
            return;
        }

        // Check if pinyin row already exists
        if (document.getElementById('pinyin')) {
            console.log('Pinyin row already exists');
            return;
        }

        // Find the row with the "zw" input
        const zwRow = Array.from(nsbox.querySelectorAll('.row')).find(row =>
            row.querySelector('#zw')
        );

        if (!zwRow) {
            console.log('zw row not found');
            return;
        }

        console.log('Creating pinyin row');

        // Create pinyin row with a button to get pinyin
        const pinyinRow = document.createElement('div');
        pinyinRow.className = 'row';
        pinyinRow.innerHTML = `
            <span style="display:inline-block;width:30px;color:white;font-size:12px;padding:6px;background:green;">py</span>
            <input class="col" style="padding:0;font-size: 12px;" id="pinyin" placeholder="Pinyin" readonly>
            <button class="btn btn-info" type="button" id="getPinyinBtn" style="font-size: 12px;"><i class="fas fa-language"></i></button>
            <button class="btn btn-warning" type="button" id="speakChineseBtn" style="font-size: 12px;" title="Pronounce Chinese word"><i class="fas fa-volume-up"></i></button>
        `;

        // Insert the pinyin row after the zw row
        zwRow.parentNode.insertBefore(pinyinRow, zwRow.nextSibling);
        console.log('Pinyin row inserted');

        // Add click event to the pinyin button
        const getPinyinBtn = document.getElementById('getPinyinBtn');
        if (getPinyinBtn) {
            console.log('Adding click listener to pinyin button');
            getPinyinBtn.addEventListener('click', updatePinyin);
        }

        // Add click event to the speak button
        const speakBtn = document.getElementById('speakChineseBtn');
        if (speakBtn) {
            speakBtn.addEventListener('click', speakChinese);
        }

        // Also add input event listener to zw input for automatic update
        const zwInput = document.getElementById('zw');
        if (zwInput) {
            console.log('Adding event listener to zw input');
            zwInput.addEventListener('input', updatePinyin);

            // Also trigger immediately if there's already text
            if (zwInput.value.trim()) {
                console.log('Triggering initial pinyin update');
                updatePinyin();
            }
        } else {
            console.log('zw input not found for event listener');
        }
    }

    /**
     * Add button to the nsbox element
     */
    function addButtonToNsbox() {
        const nsbox = document.getElementById('nsbox');
        if (!nsbox) {
            return; // nsbox not found, might not be loaded yet
        }

        // Check if button already exists
        if (document.getElementById('addChineseBtn')) {
            return;
        }

        // Find the row with the "zw" input
        const zwRow = Array.from(nsbox.querySelectorAll('.row')).find(row =>
            row.querySelector('#zw')
        );

        if (zwRow) {
            // Create the add button
            const addButton = document.createElement('button');
            addButton.id = 'addChineseBtn';
            addButton.className = 'btn btn-success';
            addButton.type = 'button';
            addButton.style.fontSize = '12px';
            addButton.innerHTML = '<i class="fas fa-plus"></i> Add';
            addButton.title = 'Add Chinese word to localStorage';

            addButton.addEventListener('click', addChineseToLocalStorage);

            // Insert the button after the search button
            const searchButton = zwRow.querySelector('button[onclick*="googlesearch"]');
            if (searchButton) {
                searchButton.parentNode.insertBefore(addButton, searchButton.nextSibling);
            } else {
                // Fallback: append to the row
                zwRow.appendChild(addButton);
            }
        }

        // Add pinyin row
        addPinyinRow();

        // Add the "Hoa Toàn Bộ" button next to the English "Dùng" button
        addCapitalizeAllButton();
    }

    /**
     * Add a "Hoa Toàn Bộ" button next to the English "Dùng" button
     * (the one that calls addSuperName('el')) so users can also call
     * addSuperName('el', 'a') in one click.
     */
    function addCapitalizeAllButton() {
        // Avoid duplicates
        if (document.getElementById('capitalizeEnglishBtn')) {
            return;
        }

        // Find the English "Dùng" button — it has onclick="addSuperName('el')"
        const dungBtn = document.querySelector('button[onclick="addSuperName(\'el\')"]');
        if (!dungBtn) {
            return;
        }

        const newBtn = document.createElement('button');
        newBtn.id = 'capitalizeEnglishBtn';
        newBtn.type = 'button';
        newBtn.textContent = 'Hoa Toàn Bộ';
        newBtn.style.float = 'right';
        newBtn.style.marginRight = '4px';

        // addSuperName('el','a') doesn't work, so instead we title-case the
        // input value ourselves (capitalize the first letter of each word,
        // like a name) and then call the regular addSuperName('el').
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

            // Title-case: uppercase the first letter of each whitespace-
            // separated word, lowercase the rest. e.g. "john smith" -> "John Smith".
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
        // (with float: right, the first DOM element ends up on the right,
        //  so this places "Hoa Toàn Bộ" immediately to the LEFT of "Dùng")
        dungBtn.parentNode.insertBefore(newBtn, dungBtn);
    }

    /**
     * Monitor for nsbox element and add button when it appears
     */
    function monitorForNsbox() {
        // Check immediately
        addButtonToNsbox();

        // Set up observer to watch for the nsbox element
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

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // Also check periodically in case the element is updated
        setInterval(addButtonToNsbox, 1000);
    }

    /**
     * Initialize the script
     */
    async function init() {
        // Load pinyin library first
        try {
            await loadPinyinLibrary();
        } catch (error) {
            console.error('Could not load pinyin library:', error);
        }

        // Wait for page to load
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                addRunButton();
                addMergeButton();
                addKeyboardShortcut();
                monitorForNsbox();
            });
        } else {
            addRunButton();
            addMergeButton();
            addScanButton();
            addKeyboardShortcut();
            monitorForNsbox();
        }

        console.log('LocalStorage Extractor loaded. Use Ctrl+Shift+E or click the button to extract data.');
    }

    // Start the script
    init();

})();
