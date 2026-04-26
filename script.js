// ==UserScript==
// @name         LocalStorage Value Extractor
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Extract localStorage values and copy to clipboard
// @author       You
// @match        https://sangtacviet.com/truyen/*/*
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

        // Add global entries to story if not present (all entries)
        globalEntries.forEach(entry => {
            if (!storySet.has(entry)) {
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
            addKeyboardShortcut();
            monitorForNsbox();
        }

        console.log('LocalStorage Extractor loaded. Use Ctrl+Shift+E or click the button to extract data.');
    }

    // Start the script
    init();

})();
