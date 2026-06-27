/* =====================================================================
   MOD SELECTION GRID
   Loads mod_index.json, renders cards, handles search/filter/play.
   ===================================================================== */

(function () {
    "use strict";

    const PAGE_SIZE = 24;
    let allMods = [];
    let filteredMods = [];
    let visibleCount = 0;
    let currentEra = "all";
    let searchTerm = "";
    let sortMode = "alpha";

    const ERAS = [
        { label: "All",      key: "all",    test: () => true },
        { label: "Pre-1700", key: "pre1700", test: t => /^(BCE|[0-9]{1,3}\b|1[0-6][0-9]{2})/.test(t) },
        { label: "1700s–1800s", key: "1700s", test: t => /1[78][0-9]{2}/.test(t) },
        { label: "1900–1939", key: "1900s", test: t => /19[0-3][0-9]/.test(t) },
        { label: "1940s–50s", key: "1940s", test: t => /19[4-5][0-9]/.test(t) },
        { label: "1960s–70s", key: "1960s", test: t => /19[6-7][0-9]/.test(t) },
        { label: "1980s–90s", key: "1980s", test: t => /19[8-9][0-9]/.test(t) },
        { label: "2000s",    key: "2000s", test: t => /200[0-9]/.test(t) },
        { label: "2010s",    key: "2010s", test: t => /201[0-9]/.test(t) },
        { label: "2020s+",   key: "2020s", test: t => /20[2-9][0-9]/.test(t) },
        { label: "Alt/Int'l", key: "other", test: (t, id) => {
            // Doesn't match any year pattern — likely alt-hist or international
            return !/^\d{4}/.test(t) && !/^(BCE|[0-9]{1,3}\b)/.test(t);
        }},
    ];

    // ----------------------------------------------------------------
    // Build the section HTML into the page
    // ----------------------------------------------------------------
    function buildSection() {
        const eraButtons = ERAS.map(e =>
            `<button class="mod-era-btn${e.key === "all" ? " active" : ""}" data-era="${e.key}">${e.label}</button>`
        ).join("");

        const section = document.createElement("div");
        section.id = "mod-select-section";
        section.innerHTML = `
            <h3>Browse &amp; Play Mods</h3>
            <div id="mod-tab-bar">${eraButtons}</div>
            <div id="mod-controls">
                <input id="mod-search" type="text" placeholder="Search mods by name...">
                <select id="mod-sort">
                    <option value="alpha">A → Z</option>
                    <option value="alpha-desc">Z → A</option>
                </select>
            </div>
            <div id="mod-card-grid"></div>
            <div id="mod-no-results">No mods found. Try a different search or era.</div>
            <div id="mod-load-more-wrap">
                <button id="mod-load-more">Load More</button>
            </div>
        `;

        // Insert after the main content_single div's footer
        const footer = document.querySelector(".footer");
        if (footer) {
            footer.parentNode.insertBefore(section, footer.nextSibling);
        } else {
            document.body.appendChild(section);
        }

        // Wire events
        document.getElementById("mod-tab-bar").addEventListener("click", e => {
            const btn = e.target.closest(".mod-era-btn");
            if (!btn) return;
            document.querySelectorAll(".mod-era-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            currentEra = btn.dataset.era;
            refilter();
        });

        document.getElementById("mod-search").addEventListener("input", e => {
            searchTerm = e.target.value.toLowerCase().trim();
            refilter();
        });

        document.getElementById("mod-sort").addEventListener("change", e => {
            sortMode = e.target.value;
            refilter();
        });

        document.getElementById("mod-load-more").addEventListener("click", () => {
            renderMore();
        });
    }

    // ----------------------------------------------------------------
    // Load the mod index JSON
    // ----------------------------------------------------------------
    function loadMods() {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", "../static/json/mod_index.json", true);
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status === 200) {
                try {
                    allMods = JSON.parse(xhr.responseText);
                    refilter();
                } catch (e) {
                    console.error("[ModSelect] Failed to parse mod_index.json:", e);
                }
            } else {
                console.error("[ModSelect] Failed to load mod_index.json:", xhr.status);
            }
        };
        xhr.send();
    }

    // ----------------------------------------------------------------
    // Filter + sort + reset pagination
    // ----------------------------------------------------------------
    function refilter() {
        const era = ERAS.find(e => e.key === currentEra) || ERAS[0];

        filteredMods = allMods.filter(mod => {
            if (searchTerm && !mod.title.toLowerCase().includes(searchTerm) &&
                !mod.id.toLowerCase().includes(searchTerm) &&
                !mod.desc.toLowerCase().includes(searchTerm)) return false;
            if (currentEra !== "all" && !era.test(mod.title, mod.id)) return false;
            return true;
        });

        // Sort
        filteredMods.sort((a, b) => {
            if (sortMode === "alpha") return a.title.localeCompare(b.title);
            if (sortMode === "alpha-desc") return b.title.localeCompare(a.title);
            return 0;
        });

        visibleCount = 0;
        document.getElementById("mod-card-grid").innerHTML = "";
        document.getElementById("mod-no-results").style.display = "none";
        renderMore();
    }

    // ----------------------------------------------------------------
    // Render next PAGE_SIZE cards
    // ----------------------------------------------------------------
    function renderMore() {
        const grid = document.getElementById("mod-card-grid");
        const slice = filteredMods.slice(visibleCount, visibleCount + PAGE_SIZE);

        if (visibleCount === 0 && slice.length === 0) {
            document.getElementById("mod-no-results").style.display = "block";
            document.getElementById("mod-load-more").style.display = "none";
            return;
        }

        slice.forEach(mod => {
            grid.appendChild(buildCard(mod));
        });

        visibleCount += slice.length;

        const loadMore = document.getElementById("mod-load-more");
        loadMore.style.display = visibleCount < filteredMods.length ? "inline-block" : "none";
    }

    // ----------------------------------------------------------------
    // Build a single mod card element
    // ----------------------------------------------------------------
    function buildCard(mod) {
        const card = document.createElement("div");
        card.className = "mod-card";
        card.dataset.modId = mod.id;

        const imgHtml = mod.img
            ? `<img class="mod-card-img" src="${escHtml(mod.img)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
              + `<div class="mod-card-img-placeholder" style="display:none">🗳️</div>`
            : `<div class="mod-card-img-placeholder">🗳️</div>`;

        card.innerHTML = `
            <div class="mod-card-title">${escHtml(mod.title)}</div>
            ${imgHtml}
            <div class="mod-card-desc">${escHtml(mod.desc || "No description available.")}</div>
            <div class="mod-card-footer">
                <button class="mod-card-play-btn" data-mod-id="${escHtml(mod.id)}">▶ Play</button>
            </div>
        `;

        card.querySelector(".mod-card-play-btn").addEventListener("click", e => {
            e.stopPropagation();
            launchMod(mod.id);
        });

        card.addEventListener("click", () => {
            document.querySelectorAll(".mod-card.selected").forEach(c => c.classList.remove("selected"));
            card.classList.add("selected");
        });

        return card;
    }

    // ----------------------------------------------------------------
    // Launch a mod: load its init file, then trigger game start
    // ----------------------------------------------------------------
    function launchMod(modId) {
        // Deselect any highlighted card and show feedback
        document.querySelectorAll(".mod-card.selected").forEach(c => c.classList.remove("selected"));
        const card = document.querySelector(`.mod-card[data-mod-id="${CSS.escape(modId)}"]`);
        if (card) card.classList.add("selected");

        // Use the same loading mechanism as the existing mod_loader.js:
        // set the modSelect value and fire its change + submit handlers.
        const sel = document.getElementById("modSelect");
        if (sel) {
            // Find the matching option
            let found = false;
            for (let i = 0; i < sel.options.length; i++) {
                if (sel.options[i].value === modId) {
                    sel.selectedIndex = i;
                    found = true;
                    break;
                }
            }
            if (!found) {
                // Option might not be pre-populated. Add it temporarily.
                const opt = document.createElement("option");
                opt.value = modId;
                opt.text = modId;
                sel.appendChild(opt);
                sel.value = modId;
            }
            // Fire modSelectChange if it exists (loads the mod data)
            if (typeof modSelectChange === "function") modSelectChange();
        }

        // Load the mod init file directly (mirrors what submitMod does)
        const initUrl = "../static/mods/" + modId + "_init.html";
        const xhr = new XMLHttpRequest();
        xhr.open("GET", initUrl, true);
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status !== 200) {
                alert("Could not load mod: " + modId);
                return;
            }
            try {
                // eslint-disable-next-line no-eval
                eval(xhr.responseText);
                if (typeof diff_mod !== "undefined") diff_mod = true;
                // Scroll up and prompt the user to click "Click here to begin!"
                window.scrollTo({ top: 0, behavior: "smooth" });
                // Visual feedback
                showModLoadedBanner(modId);
            } catch (err) {
                console.error("[ModSelect] Error loading mod:", err);
                alert("Error loading mod. See console for details.");
            }
        };
        xhr.send();
    }

    function showModLoadedBanner(modId) {
        let banner = document.getElementById("mod-loaded-banner");
        if (!banner) {
            banner = document.createElement("div");
            banner.id = "mod-loaded-banner";
            banner.style.cssText = "background:#2d6a2d;color:#fff;text-align:center;padding:0.8em 1em;" +
                "font-size:1.4em;font-weight:bold;position:sticky;top:0;z-index:999;";
            const gameWindow = document.getElementById("game_window");
            if (gameWindow) gameWindow.prepend(banner);
            else document.body.prepend(banner);
        }
        banner.textContent = `✓ Mod loaded: "${modId}" — now click "Click here to begin!" above!`;
        setTimeout(() => { if (banner.parentNode) banner.parentNode.removeChild(banner); }, 8000);
    }

    function escHtml(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    // ----------------------------------------------------------------
    // Init
    // ----------------------------------------------------------------
    document.addEventListener("DOMContentLoaded", function () {
        buildSection();
        loadMods();
    });
})();
