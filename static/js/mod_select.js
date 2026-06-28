/* =====================================================================
   MOD SELECTION GRID
   Loads mod_index.json, renders cards below the game window.
   When Play is clicked, loads the mod using the same path as
   mod_loader.js's submitMod handler (evaluate + diff_mod flags).
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
        { label: "All",         key: "all" },
        { label: "Pre-1700",    key: "pre1700" },
        { label: "1700–1899",   key: "1700s" },
        { label: "1900–1939",   key: "1900s" },
        { label: "1940–1959",   key: "1940s" },
        { label: "1960–1979",   key: "1960s" },
        { label: "1980–1999",   key: "1980s" },
        { label: "2000–2009",   key: "2000s" },
        { label: "2010–2019",   key: "2010s" },
        { label: "2020s+",      key: "2020s" },
        { label: "Alt/Int'l",   key: "other" },
    ];

    function eraTest(key, title) {
        switch (key) {
            case "all":    return true;
            case "pre1700": return /^(BCE|AD|[0-9]{1,3}\b|1[0-6][0-9]{2}\b)/.test(title);
            case "1700s":  return /1[78][0-9]{2}/.test(title);
            case "1900s":  return /19[0-3][0-9]/.test(title);
            case "1940s":  return /19[4-5][0-9]/.test(title);
            case "1960s":  return /19[6-7][0-9]/.test(title);
            case "1980s":  return /19[8-9][0-9]/.test(title);
            case "2000s":  return /200[0-9]/.test(title);
            case "2010s":  return /201[0-9]/.test(title);
            case "2020s":  return /20[2-9][0-9]/.test(title);
            case "other":  return !/\b(1[0-9]{3}|[0-9]{1,3})\b/.test(title) && !/BCE|AD/.test(title);
        }
        return true;
    }

    // ----------------------------------------------------------------
    // Insert mod section into the page after .footer
    // ----------------------------------------------------------------
    function buildSection() {
        var eraButtons = ERAS.map(function(e) {
            return '<button class="mod-era-btn' + (e.key === "all" ? " active" : "") + '" data-era="' + e.key + '">' + e.label + '</button>';
        }).join("");

        var section = document.createElement("div");
        section.id = "mod-select-section";
        section.innerHTML =
            '<h3>Browse &amp; Play Mods</h3>' +
            '<div id="mod-tab-bar">' + eraButtons + '</div>' +
            '<div id="mod-controls">' +
              '<input id="mod-search" type="text" placeholder="Search mods...">' +
              '<select id="mod-sort">' +
                '<option value="alpha">A \u2192 Z</option>' +
                '<option value="alpha-desc">Z \u2192 A</option>' +
              '</select>' +
            '</div>' +
            '<div id="mod-card-grid"></div>' +
            '<div id="mod-no-results">No mods found.</div>' +
            '<div id="mod-load-more-wrap"><button id="mod-load-more">Load More</button></div>';

        // Insert after .footer
        var footer = document.querySelector(".footer");
        if (footer && footer.parentNode) {
            footer.parentNode.insertBefore(section, footer.nextSibling);
        } else {
            document.body.appendChild(section);
        }

        document.getElementById("mod-tab-bar").addEventListener("click", function(e) {
            var btn = e.target;
            if (!btn.classList.contains("mod-era-btn")) return;
            document.querySelectorAll(".mod-era-btn").forEach(function(b) { b.classList.remove("active"); });
            btn.classList.add("active");
            currentEra = btn.getAttribute("data-era");
            refilter();
        });

        document.getElementById("mod-search").addEventListener("input", function(e) {
            searchTerm = e.target.value.toLowerCase().trim();
            refilter();
        });

        document.getElementById("mod-sort").addEventListener("change", function(e) {
            sortMode = e.target.value;
            refilter();
        });

        document.getElementById("mod-load-more").addEventListener("click", function() {
            renderMore();
        });
    }

    // ----------------------------------------------------------------
    // Load mod_index.json
    // ----------------------------------------------------------------
    function loadMods() {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", "../static/json/mod_index.json", true);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== 4) return;
            if (xhr.status === 200) {
                try {
                    allMods = JSON.parse(xhr.responseText);
                    refilter();
                } catch(e) {
                    console.error("[ModSelect] JSON parse error:", e);
                }
            }
        };
        xhr.send();
    }

    // ----------------------------------------------------------------
    // Filter + sort + reset
    // ----------------------------------------------------------------
    function refilter() {
        filteredMods = allMods.filter(function(mod) {
            if (searchTerm) {
                var haystack = (mod.title + " " + mod.id + " " + mod.desc).toLowerCase();
                if (haystack.indexOf(searchTerm) === -1) return false;
            }
            if (currentEra !== "all" && !eraTest(currentEra, mod.title)) return false;
            return true;
        });

        filteredMods.sort(function(a, b) {
            if (sortMode === "alpha-desc") return b.title.localeCompare(a.title);
            return a.title.localeCompare(b.title);
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
        var grid = document.getElementById("mod-card-grid");
        var slice = filteredMods.slice(visibleCount, visibleCount + PAGE_SIZE);

        if (visibleCount === 0 && slice.length === 0) {
            document.getElementById("mod-no-results").style.display = "block";
            document.getElementById("mod-load-more").style.display = "none";
            return;
        }

        for (var i = 0; i < slice.length; i++) {
            grid.appendChild(buildCard(slice[i]));
        }

        visibleCount += slice.length;
        document.getElementById("mod-load-more").style.display =
            visibleCount < filteredMods.length ? "inline-block" : "none";
    }

    // ----------------------------------------------------------------
    // Build a card element
    // ----------------------------------------------------------------
    function buildCard(mod) {
        var card = document.createElement("div");
        card.className = "mod-card";
        card.setAttribute("data-mod-id", mod.id);

        var imgHtml = mod.img
            ? '<div class="mod-card-img-wrap"><img class="mod-card-img" src="' + esc(mod.img) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'"></div>'
            : '<div class="mod-card-img-placeholder">\uD83D\uDDF3\uFE0F</div>';

        card.innerHTML =
            '<div class="mod-card-title">' + esc(mod.title) + '</div>' +
            imgHtml +
            '<div class="mod-card-desc">' + esc(mod.desc || "No description available.") + '</div>' +
            '<div class="mod-card-footer">' +
              '<button class="mod-card-play-btn">\u25B6 Play</button>' +
            '</div>';

        card.querySelector(".mod-card-play-btn").addEventListener("click", function(e) {
            e.stopPropagation();
            launchMod(mod.id, mod.title);
        });

        return card;
    }

    // ----------------------------------------------------------------
    // Launch a mod — mirrors submitMod in mod_loader.js exactly
    // ----------------------------------------------------------------
    function launchMod(modId, modTitle) {
        // Visual feedback on the card
        document.querySelectorAll(".mod-card.selected").forEach(function(c) { c.classList.remove("selected"); });
        var card = document.querySelector('.mod-card[data-mod-id="' + CSS.escape(modId) + '"]');
        if (card) card.classList.add("selected");

        // Set modSelect value (for mod_loader.js compatibility)
        var sel = document.getElementById("modSelect");
        if (sel) sel.value = modId;

        // Load and evaluate the mod init file — same as submitMod does
        var client = new XMLHttpRequest();
        client.open("GET", "../static/mods/" + modId + "_init.html");
        client.onreadystatechange = function() {
            if (client.readyState !== 4) return;
            if (client.status !== 200) {
                alert("Could not load mod: " + modId);
                return;
            }
            if (client.responseText.length > 0) {
                // Reset the guard flag so evaluate() runs fresh
                if (typeof e !== "undefined") e.readyToLoadCode1 = false;
                evaluate(client.responseText);
                if (typeof e !== "undefined") e.readyToLoadCode1 = true;
            }
            diff_mod = true;
            if (typeof modded !== "undefined") modded = true;

            // Scroll to top and show banner
            window.scrollTo({ top: 0, behavior: "smooth" });
            showBanner(modTitle || modId);
        };
        client.send();
    }

    function showBanner(title) {
        var banner = document.getElementById("mod-loaded-banner");
        if (!banner) {
            banner = document.createElement("div");
            banner.id = "mod-loaded-banner";
            banner.style.cssText =
                "background:#2d6a2d;color:#fff;text-align:center;padding:0.8em 1em;" +
                "font-size:1.3em;font-weight:bold;position:sticky;top:0;z-index:9999;cursor:pointer;";
            banner.title = "Click to dismiss";
            banner.addEventListener("click", function() { banner.remove(); });
            var gw = document.getElementById("game_window");
            if (gw) gw.parentNode.insertBefore(banner, gw);
            else document.body.prepend(banner);
        }
        banner.textContent = "\u2713 Mod loaded: \"" + title + "\" \u2014 now click \u201CClick here to begin!\u201D above!";
        clearTimeout(banner._timer);
        banner._timer = setTimeout(function() { if (banner.parentNode) banner.remove(); }, 10000);
    }

    function esc(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    // ----------------------------------------------------------------
    // Init on DOMContentLoaded
    // ----------------------------------------------------------------
    document.addEventListener("DOMContentLoaded", function() {
        buildSection();
        loadMods();
    });
})();
