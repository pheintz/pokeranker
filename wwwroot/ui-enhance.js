/**
 * ui-enhance.js — progressive UX layer on top of app.js.
 *
 * Everything here is additive: if this file fails to load, the page still
 * works because onchange/initLeagues are wired up in index.html and app.js.
 *
 * Responsibilities:
 *   1. Wire buttons (replacing the old inline onclick= handlers).
 *   2. File upload + drag-drop into the textarea.
 *   3. Clear button.
 *   4. Ctrl/Cmd + Enter shortcut to run Analyze.
 *   5. Button loading state (aria-busy + disabled) for async actions.
 *   6. Tab switching between Analyze / Meta / Box outputs, with auto-switch
 *      when a panel gets populated.
 *   7. Empty-state hiding once a panel has real content.
 *   8. Sortable columns on any .group > table.
 */
(function () {
    'use strict';

    // ── Helpers ──────────────────────────────────────────────────────────
    const $  = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

    function onReady(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn, { once: true });
        } else {
            fn();
        }
    }

    /**
     * Wrap an async handler so the triggering button shows a loading state.
     * Button is disabled + aria-busy until the promise resolves.
     */
    function withLoading(button, handler) {
        return async function (...args) {
            if (!button) return handler(...args);

            // Label node is either a child <span> (for buttons that also contain
            // e.g. a keyboard-hint span) or the button itself.
            const labelSpan = button.querySelector('span:not(.btn-hint)');
            const labelNode = labelSpan || button;
            const original  = labelNode.textContent;

            button.setAttribute('aria-busy', 'true');
            button.disabled = true;
            labelNode.textContent = 'Working…';

            try {
                return await handler(...args);
            } finally {
                button.removeAttribute('aria-busy');
                button.disabled = false;
                labelNode.textContent = original;
            }
        };
    }

    // ── Tabs ─────────────────────────────────────────────────────────────
    const TAB_MAP = {
        'out':      'tab-analyze',
        'meta-out': 'tab-meta',
        'box-out':  'tab-box',
    };

    function activateTab(tabId) {
        $$('.tab').forEach(t => {
            const active = t.id === tabId;
            t.classList.toggle('active', active);
            t.setAttribute('aria-selected', active ? 'true' : 'false');
            t.tabIndex = active ? 0 : -1;
        });
        $$('.tab-panel').forEach(p => {
            const shouldShow = p.getAttribute('aria-labelledby') === tabId;
            p.hidden = !shouldShow;
        });
    }

    function hideEmptyStateIfPopulated(outputId) {
        const out = document.getElementById(outputId);
        if (!out) return;
        const hasContent = out.textContent.trim().length > 0 || out.children.length > 0;
        const empty = document.getElementById('empty-' + outputId.replace('-out', '').replace('out', 'analyze'));
        // The empty-state IDs are: empty-analyze, empty-meta, empty-box
        const emptyId = ({ 'out': 'empty-analyze', 'meta-out': 'empty-meta', 'box-out': 'empty-box' })[outputId];
        const emptyEl = document.getElementById(emptyId);
        if (emptyEl) emptyEl.hidden = hasContent;
    }

    function wireTabs() {
        $$('.tab').forEach(tab => {
            tab.addEventListener('click', () => activateTab(tab.id));
            tab.addEventListener('keydown', (e) => {
                const tabs = $$('.tab');
                const idx = tabs.indexOf(tab);
                if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    tabs[(idx + 1) % tabs.length].focus();
                    activateTab(tabs[(idx + 1) % tabs.length].id);
                } else if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    tabs[(idx - 1 + tabs.length) % tabs.length].focus();
                    activateTab(tabs[(idx - 1 + tabs.length) % tabs.length].id);
                }
            });
        });
    }

    /**
     * Observe the three output regions. When one changes, switch to its tab
     * and hide its empty-state + apply sortable headers to any new tables.
     */
    function observeOutputs() {
        for (const [outId, tabId] of Object.entries(TAB_MAP)) {
            const el = document.getElementById(outId);
            if (!el) continue;

            const observer = new MutationObserver(() => {
                // Only switch when the content is "real" results, not the transient
                // "Computing…" message. Switching for the loading message is still
                // better than nothing — user sees progress inside the right panel.
                activateTab(tabId);
                hideEmptyStateIfPopulated(outId);
                applySortable(el);
                // Reflect aria-busy state: if only a <p> with "Computing" text, busy.
                const txt = el.textContent || '';
                el.setAttribute('aria-busy', /computing|loading/i.test(txt) ? 'true' : 'false');
            });
            observer.observe(el, { childList: true, subtree: false });
        }
    }

    // ── Sortable tables ──────────────────────────────────────────────────
    /**
     * For each <table> inside a .group, make headers click-sortable.
     * Simple text/numeric comparison inferred from the cell contents.
     */
    function applySortable(root) {
        $$('.group table', root).forEach(table => {
            if (table.dataset.sortable) return;
            table.dataset.sortable = '1';
            const headers = $$('thead th', table);
            headers.forEach((th, colIdx) => {
                th.classList.add('sortable');
                th.tabIndex = 0;
                th.setAttribute('role', 'button');
                th.setAttribute('aria-label', th.textContent.trim() + ' — click to sort');
                const handler = () => sortByColumn(table, colIdx, th);
                th.addEventListener('click', handler);
                th.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
                });
            });
        });
    }

    function sortByColumn(table, colIdx, th) {
        const tbody = table.querySelector('tbody');
        if (!tbody) return;
        const rows = [...tbody.querySelectorAll('tr')];
        const currentDir = th.classList.contains('sort-asc') ? 'asc'
                         : th.classList.contains('sort-desc') ? 'desc'
                         : null;
        const dir = currentDir === 'asc' ? 'desc' : 'asc';

        // Clear siblings
        $$('th', table).forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
        th.classList.add(dir === 'asc' ? 'sort-asc' : 'sort-desc');

        const getValue = (row) => {
            const cell = row.children[colIdx];
            if (!cell) return '';
            const txt = cell.textContent.trim();
            // Try to extract a number (handles "45.2%", "1,234", "12/15/15")
            const numMatch = txt.match(/-?\d+(\.\d+)?/);
            if (numMatch) return parseFloat(numMatch[0]);
            return txt.toLowerCase();
        };

        rows.sort((a, b) => {
            const av = getValue(a), bv = getValue(b);
            if (typeof av === 'number' && typeof bv === 'number') {
                return dir === 'asc' ? av - bv : bv - av;
            }
            return dir === 'asc' ? String(av).localeCompare(String(bv))
                                 : String(bv).localeCompare(String(av));
        });

        rows.forEach(r => tbody.appendChild(r));
    }

    // ── File upload / drag-drop ──────────────────────────────────────────
    function wireFileInput() {
        const textarea  = $('#csv');
        const fileInput = $('#file-input');
        const uploadBtn = $('#upload-btn');
        const dropZone  = $('#drop-zone');
        if (!textarea || !fileInput || !dropZone) return;

        uploadBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            fileInput.click();
        });

        fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            textarea.value = await file.text();
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        });

        // Drag-drop onto the whole drop zone
        ['dragenter', 'dragover'].forEach(ev => {
            dropZone.addEventListener(ev, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropZone.classList.add('is-dragover');
            });
        });
        ['dragleave', 'drop'].forEach(ev => {
            dropZone.addEventListener(ev, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropZone.classList.remove('is-dragover');
            });
        });
        dropZone.addEventListener('drop', async (e) => {
            const file = e.dataTransfer?.files?.[0];
            if (!file) return;
            textarea.value = await file.text();
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }

    // ── Button wiring ────────────────────────────────────────────────────
    function wireButtons() {
        const analyzeBtn = $('#analyze-btn');
        const demoBtn    = $('#demo-btn');
        const clearBtn   = $('#clear-btn');
        const metaBtn    = $('#meta-btn');
        const boxBtn     = $('#box-btn');
        const leagueSel  = $('#league');
        const textarea   = $('#csv');

        leagueSel?.addEventListener('change', () => {
            if (typeof onLeagueChange === 'function') onLeagueChange();
        });

        // Analyze flow: run box analysis, then auto-chain into the team builder
        // so the user lands on a team recommendation instead of a sorted list.
        // The "Box analysis" tab stays populated for reference; we switch to
        // "Teams from my box" once teams are ready (~few seconds of sim work).
        // If analysis produced nothing usable (empty box, parse error), skip
        // the chain — runBoxBuilder bails on empty input anyway, but switching
        // tabs to a dead view is worse UX than staying on the analysis pane.
        analyzeBtn?.addEventListener('click', withLoading(analyzeBtn, async () => {
            if (typeof run !== 'function') return;
            await run();
            // Heuristic: only auto-chain if Analyze populated the box species set.
            // (lastAnalysisBox is set inside run() on success.)
            const boxReady = typeof lastAnalysisBox !== 'undefined' && lastAnalysisBox.size > 0;
            if (boxReady && typeof runBoxBuilder === 'function') {
                activateTab('tab-box');
                await runBoxBuilder();
            }
        }));

        demoBtn?.addEventListener('click', () => {
            if (typeof demo === 'function') demo();
        });

        clearBtn?.addEventListener('click', () => {
            if (!textarea) return;
            textarea.value = '';
            textarea.focus();
            // Also clear any output panels so the empty state returns
            ['out', 'meta-out', 'box-out'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.innerHTML = '';
                hideEmptyStateIfPopulated(id);
            });
            activateTab('tab-analyze');
        });

        metaBtn?.addEventListener('click', withLoading(metaBtn, async () => {
            if (typeof runMetaBreaker === 'function') await runMetaBreaker();
        }));

        boxBtn?.addEventListener('click', withLoading(boxBtn, async () => {
            if (typeof runBoxBuilder === 'function') await runBoxBuilder();
        }));
    }

    // ── Keyboard shortcuts ───────────────────────────────────────────────
    function wireShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Ctrl/Cmd + Enter → Analyze
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                $('#analyze-btn')?.click();
            }
        });
    }

    // ── Bootstrap ────────────────────────────────────────────────────────
    onReady(() => {
        wireTabs();
        observeOutputs();
        wireFileInput();
        wireButtons();
        wireShortcuts();

        // Initial empty-state check (panels are empty at load)
        ['out', 'meta-out', 'box-out'].forEach(hideEmptyStateIfPopulated);
    });
})();
