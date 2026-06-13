/* =====================================================================
   NEW CAMPAIGN TRAIL — ONLINE MULTIPLAYER MODULE
   =====================================================================

   This file adds a "Play Online" mode where two human players each
   control one of the candidates in a scenario and play it out together
   in real time, using Firebase Realtime Database as the relay.

   HOW IT WORKS (high level):
   - The HOST plays through the normal single-player setup screens
     (pick year, candidate, running mate, game mode, difficulty) exactly
     as before. Once the first question loads, a small "Multiplayer
     Setup" panel appears letting the host pick which of the available
     opponents the second player will control, and set a per-turn time
     limit (capped at 60 minutes). This creates a room with a short code.
   - The GUEST enters that room code. Their client loads the *same*
     scenario data file the host is using (so all underlying numbers
     match), then re-points itself at the candidate the host assigned
     to them.
   - Each turn, both players answer their own candidate's question (and
     pick a campaign visit, if the scenario uses visits) independently.
     Once both answers are in Firebase, each client locally records the
     other player's answer and advances its own copy of the simulation.
     Because both clients start from identical data and apply the same
     two answer-histories, they stay in sync without needing to send
     the whole game state back and forth.
   - At the final question, the host computes the official result and
     shares it, so both players see the same election outcome.

   SCOPE / KNOWN LIMITATIONS (v1):
   - Supports standard (non-modded) General Election scenarios — the
     large majority of years available in the game.
   - "Sea to Shining Sea" economy mode, primaries, and Choose-Your-Own-
     Adventure scenarios are not supported in online play (the host's
     multiplayer setup panel will say so if the chosen mode isn't
     supported).
   - The guest's running mate is auto-selected (first listed running
     mate for their candidate). Running mate choice has only a minor
     effect on gameplay.

   SETUP REQUIRED: see MULTIPLAYER_SETUP.md for how to create a free
   Firebase project and fill in the config below.
   ===================================================================== */

(function () {
    "use strict";

    // -----------------------------------------------------------------
    // 1. FIREBASE CONFIG — replace with your own project's config.
    //    See MULTIPLAYER_SETUP.md for step-by-step instructions.
    // -----------------------------------------------------------------
    const FIREBASE_CONFIG = {
        apiKey: "AIzaSyDakwoONMVcFJxYtPPxpM8ZNxx4YytSjxw",
        authDomain: "the-campaign-trail-multiplayer.firebaseapp.com",
        databaseURL: "https://the-campaign-trail-multiplayer-default-rtdb.europe-west1.firebasedatabase.app",
        projectId: "the-campaign-trail-multiplayer",
    };

    const MAX_TIME_LIMIT_SECONDS = 60 * 60; // hard cap: 1 hour
    const DEFAULT_TIME_LIMIT_SECONDS = 5 * 60; // 5 minutes per turn
    const MIN_TIME_LIMIT_SECONDS = 15;

    let db = null;
    let firebaseReady = false;

    function initFirebase() {
        if (firebaseReady) return true;
        if (typeof firebase === "undefined") {
            console.error("[MP] Firebase SDK not loaded.");
            return false;
        }
        if (FIREBASE_CONFIG.apiKey === "YOUR_API_KEY") {
            console.error("[MP] Firebase config has not been filled in. See MULTIPLAYER_SETUP.md");
            return false;
        }
        try {
            if (!firebase.apps || !firebase.apps.length) {
                firebase.initializeApp(FIREBASE_CONFIG);
            }
            db = firebase.database();
            firebaseReady = true;
            return true;
        } catch (err) {
            console.error("[MP] Failed to initialize Firebase:", err);
            return false;
        }
    }

    // -----------------------------------------------------------------
    // 2. STATE
    // -----------------------------------------------------------------
    const MP = {
        active: false,
        role: null, // "host" | "guest"
        roomId: null,
        roomRef: null,
        timeLimitSeconds: DEFAULT_TIME_LIMIT_SECONDS,
        appliedTurns: {}, // questionNumber -> true once both answers applied locally
        turnListeners: {},
        deadlineTimer: null,
        currentDeadline: null,
        myTurnAnswered: false,
    };
    window.MP = MP;

    // -----------------------------------------------------------------
    // 3. HELPERS
    // -----------------------------------------------------------------
    function getInternals() {
        return campaignTrail_temp.MP_internal || {};
    }

    function makeRoomCode() {
        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
        let code = "";
        for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
        return code;
    }

    // Find a candidate's home state pk (for running-mate state bonuses),
    // given a candidate pk and the candidate.json "state" name field.
    function stateNameToPk(stateName) {
        const e = campaignTrail_temp;
        const found = (e.states_json || []).find(s => s.fields.name === stateName);
        return found ? found.pk : null;
    }

    function getCandidateRecord(pk) {
        const e = campaignTrail_temp;
        return (e.candidate_json || []).find(c => c.pk === Number(pk));
    }

    // Mirrors the dropout-filtering logic used in candSel(), so the guest's
    // opponents_list excludes candidates whose presence is conditional on
    // the host's candidate choice (and vice versa for symmetry).
    function computeOpponentsList(electionId, myCandidateId) {
        const e = campaignTrail_temp;
        const oppEntry = (e.opponents_default_json || []).find(f => f.election === electionId);
        if (!oppEntry) return [];

        const droppedOut = (e.candidate_dropout_json || [])
            .filter(f => f.fields.candidate === myCandidateId)
            .map(f => f.fields.affected_candidate);

        return oppEntry.candidates.filter(c => c !== myCandidateId && droppedOut.indexOf(c) === -1);
    }

    function firstRunningMateFor(candidateId) {
        const e = campaignTrail_temp;
        const match = (e.running_mate_json || []).find(f => f.fields.candidate === Number(candidateId));
        return match ? match.fields.running_mate : null;
    }

    function runningMateStateIdFor(candidateId) {
        const rmPk = firstRunningMateFor(candidateId);
        if (rmPk == null) return null;
        const rec = getCandidateRecord(rmPk);
        if (!rec) return null;
        return stateNameToPk(rec.fields.state);
    }

    function clearDeadlineTimer() {
        if (MP.deadlineTimer) {
            clearInterval(MP.deadlineTimer);
            MP.deadlineTimer = null;
        }
        $("#mp_turn_timer").remove();
    }

    // -----------------------------------------------------------------
    // 4. LOBBY UI
    // -----------------------------------------------------------------
    function injectLobbyButton() {
        if ($("#mp_play_online_btn")[0]) return;
        const btn = $(`<span class="campaign_trail_start_emphasis" style="margin-left:10px;">
            <button id="mp_play_online_btn"><strong>Play Online (vs. a friend)</strong></button>
        </span>`);
        $("#game_start").parent().after(btn);
        btn.find("button").click(openLobbyChoiceModal);
    }

    function modalShell(innerHtml) {
        $("#mp_modal_overlay").remove();
        const overlay = $(`
            <div id="mp_modal_overlay" style="position:fixed;top:0;left:0;width:100%;height:100%;
                 background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;">
                <div id="mp_modal_box" style="background:#fff;color:#000;max-width:480px;width:90%;
                     padding:1.5em;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,0.4);">
                    ${innerHtml}
                </div>
            </div>
        `);
        $("body").append(overlay);
        return overlay;
    }

    function closeModal() {
        $("#mp_modal_overlay").remove();
    }

    function openLobbyChoiceModal() {
        const overlay = modalShell(`
            <h3>Play Online</h3>
            <p>Play against a friend, each of you controlling one candidate, on separate devices.</p>
            <p>
                <button id="mp_host_btn">Host a Game</button>
                <button id="mp_join_btn">Join a Game</button>
                <button id="mp_cancel_btn">Cancel</button>
            </p>
        `);
        overlay.find("#mp_cancel_btn").click(closeModal);
        overlay.find("#mp_host_btn").click(() => {
            closeModal();
            startHostFlow();
        });
        overlay.find("#mp_join_btn").click(() => {
            closeModal();
            openJoinModal();
        });
    }

    function startHostFlow() {
        MP.pendingHostSetup = true;
        modalShell(`
            <h3>Host a Game — Step 1</h3>
            <p>First, set up your game the normal way: click <b>"Click here to begin!"</b> below
               and choose your election year, candidate, running mate, game mode, and difficulty.</p>
            <p><i>Once your first question loads, a multiplayer setup panel will appear automatically
               so you can invite your opponent.</i></p>
            <p><button id="mp_back_btn">Back</button></p>
        `);
        $("#mp_back_btn").click(closeModal);
        // Close the modal so the player can interact with the normal setup UI underneath.
        setTimeout(closeModal, 50);
        watchForHostSetupComplete();
    }

    function watchForHostSetupComplete() {
        const interval = setInterval(() => {
            if (!MP.pendingHostSetup) {
                clearInterval(interval);
                return;
            }
            const e = campaignTrail_temp;
            if (e.candidate_id && e.election_id && e.opponents_list && e.opponents_list.length &&
                e.question_number === 0 && $("#answer_select_button")[0]) {
                clearInterval(interval);
                MP.pendingHostSetup = false;
                openHostSetupPanel();
            }
        }, 400);
    }

    function openHostSetupPanel() {
        const e = campaignTrail_temp;

        if (String(e.game_type_id) === "3") {
            modalShell(`
                <h3>Online play unavailable for this mode</h3>
                <p>"Sea to Shining Sea" economy mode isn't supported in online multiplayer yet.
                   Please reload and set up a standard game (Default or Proportional) to play online.</p>
                <p><button id="mp_ok_btn">OK</button></p>
            `);
            $("#mp_ok_btn").click(closeModal);
            return;
        }

        const opponentOptions = e.opponents_list
            .map(pk => {
                const rec = getCandidateRecord(pk);
                const name = rec ? `${rec.fields.first_name} ${rec.fields.last_name} (${rec.fields.party})` : `Candidate ${pk}`;
                return `<option value="${pk}">${name}</option>`;
            })
            .join("");

        const overlay = modalShell(`
            <h3>Host a Game — Step 2</h3>
            <p>Your candidate: <b>${e.candidate_last_name}</b></p>
            <p>
                <label for="mp_opp_select">Which candidate will your opponent play?</label><br>
                <select id="mp_opp_select" style="width:100%;margin-top:0.3em;">${opponentOptions}</select>
            </p>
            <p>
                <label for="mp_time_limit">Time limit per turn (minutes, max 60):</label><br>
                <input type="number" id="mp_time_limit" min="1" max="60" value="5" style="width:100%;margin-top:0.3em;">
            </p>
            <p>
                <button id="mp_create_room_btn">Create Room</button>
                <button id="mp_setup_cancel_btn">Cancel</button>
            </p>
            <div id="mp_room_info"></div>
        `);

        overlay.find("#mp_setup_cancel_btn").click(closeModal);
        overlay.find("#mp_create_room_btn").click(() => {
            const guestCandidateId = Number($("#mp_opp_select").val());
            let minutes = Number($("#mp_time_limit").val());
            if (isNaN(minutes) || minutes < 1) minutes = 1;
            if (minutes > 60) minutes = 60;
            const timeLimitSeconds = Math.min(MAX_TIME_LIMIT_SECONDS, Math.max(MIN_TIME_LIMIT_SECONDS, Math.round(minutes * 60)));
            createRoomAsHost(guestCandidateId, timeLimitSeconds, overlay);
        });
    }

    function createRoomAsHost(guestCandidateId, timeLimitSeconds, overlay) {
        if (!initFirebase()) {
            overlay.find("#mp_room_info").html(`<p style="color:red;">Multiplayer isn't configured yet.
                The site owner needs to add a Firebase config — see MULTIPLAYER_SETUP.md.</p>`);
            return;
        }

        const e = campaignTrail_temp;
        const difficultyEntry = (e.difficulty_level_json || []).find(d => String(d.pk) === String(e.difficulty_level_id));
        const difficultyMultiplier = difficultyEntry ? difficultyEntry.fields.multiplier : (e.difficulty_level_multiplier || 1);

        const roomId = makeRoomCode();
        const config = {
            electionId: Number(e.election_id),
            hostCandidateId: Number(e.candidate_id),
            hostRunningMateId: Number(e.running_mate_id),
            guestCandidateId: guestCandidateId,
            gameTypeId: String(e.game_type_id),
            difficultyLevelId: Number(e.difficulty_level_id),
            difficultyMultiplier: difficultyMultiplier,
            timeLimitSeconds: timeLimitSeconds,
            createdAt: Date.now(),
            guestJoined: false,
        };

        MP.roomId = roomId;
        MP.roomRef = db.ref("rooms/" + roomId);
        MP.role = "host";
        MP.timeLimitSeconds = timeLimitSeconds;

        MP.roomRef.set({ config: config }).then(() => {
            overlay.find("#mp_room_info").html(`
                <hr>
                <p>Room created! Share this code with your opponent:</p>
                <h2 style="text-align:center;letter-spacing:0.2em;">${roomId}</h2>
                <p id="mp_waiting_text"><i>Waiting for your opponent to join...</i></p>
            `);

            MP.roomRef.child("config/guestJoined").on("value", snap => {
                if (snap.val() === true) {
                    MP.roomRef.child("config/guestJoined").off();
                    initMultiplayerState(config, "host");
                    closeModal();
                }
            });
        }).catch(err => {
            overlay.find("#mp_room_info").html(`<p style="color:red;">Could not create room: ${err.message}</p>`);
        });
    }

    function openJoinModal() {
        const overlay = modalShell(`
            <h3>Join a Game</h3>
            <p>Enter the room code your opponent shared with you. You should do this
               <b>before</b> starting a game from the main menu — your screen will be set up
               automatically to match your opponent's scenario.</p>
            <p>
                <input type="text" id="mp_join_code" maxlength="5" style="width:100%;text-transform:uppercase;
                       letter-spacing:0.2em;font-size:1.4em;text-align:center;" placeholder="ROOM CODE">
            </p>
            <p>
                <button id="mp_join_confirm_btn">Join</button>
                <button id="mp_join_cancel_btn">Cancel</button>
            </p>
            <div id="mp_join_info"></div>
        `);
        overlay.find("#mp_join_cancel_btn").click(closeModal);
        overlay.find("#mp_join_confirm_btn").click(() => {
            const code = $("#mp_join_code").val().trim().toUpperCase();
            if (!code) return;
            joinRoomAsGuest(code, overlay);
        });
    }

    function joinRoomAsGuest(roomId, overlay) {
        if (!initFirebase()) {
            overlay.find("#mp_join_info").html(`<p style="color:red;">Multiplayer isn't configured yet.
                The site owner needs to add a Firebase config — see MULTIPLAYER_SETUP.md.</p>`);
            return;
        }

        const roomRef = db.ref("rooms/" + roomId);
        roomRef.child("config").once("value").then(snap => {
            const config = snap.val();
            if (!config) {
                overlay.find("#mp_join_info").html(`<p style="color:red;">Room not found. Double-check the code.</p>`);
                return;
            }
            if (config.guestJoined) {
                overlay.find("#mp_join_info").html(`<p style="color:red;">That room already has two players.</p>`);
                return;
            }

            MP.roomId = roomId;
            MP.roomRef = roomRef;
            MP.role = "guest";
            MP.timeLimitSeconds = config.timeLimitSeconds || DEFAULT_TIME_LIMIT_SECONDS;

            roomRef.child("config/guestJoined").set(true).then(() => {
                overlay.find("#mp_join_info").html(`<p><i>Joined! Loading your scenario...</i></p>`);
                loadGuestScenario(config);
                closeModal();
            });
        }).catch(err => {
            overlay.find("#mp_join_info").html(`<p style="color:red;">Error: ${err.message}</p>`);
        });
    }

    // -----------------------------------------------------------------
    // 5. GUEST SCENARIO LOADING
    //    Loads the exact same data file the host is using, then
    //    re-points the local state at the guest's assigned candidate.
    // -----------------------------------------------------------------
    function loadGuestScenario(config) {
        // Wait until the base JSON (candidate.json, election.json, etc.)
        // has loaded before we try to look anything up.
        const waitForBaseData = setInterval(() => {
            const e = campaignTrail_temp;
            if (!(e.candidate_json && e.candidate_json.length && e.election_json && e.election_json.length &&
                  e.opponents_default_json && e.running_mate_json)) {
                return;
            }
            clearInterval(waitForBaseData);

            const internals = getInternals();
            if (!internals.election_HTML) {
                // MP_internal not ready yet (script ordering) — try again shortly.
                setTimeout(() => loadGuestScenario(config), 200);
                return;
            }

            const filename = internals.election_HTML(config.electionId, config.hostCandidateId, config.hostRunningMateId);
            const url = "../static/questionset/" + filename;

            $("#game_window").load(url, () => {
                const e2 = campaignTrail_temp;

                // Replicate the base setup that s()'s continue handler normally does.
                e2.question_number = 0;
                e2.election_id = config.electionId;
                e2.difficulty_level_id = config.difficultyLevelId;
                e2.difficulty_level_multiplier = config.difficultyMultiplier;
                e2.game_type_id = config.gameTypeId;
                e2.player_answers = [];
                e2.player_visits = [];

                // Capture the host's running-mate home state before we overwrite it.
                const hostRunningMateStateId = e2.running_mate_state_id;

                // Re-point everything at the guest's assigned candidate.
                const guestCandidateId = config.guestCandidateId;
                const guestRec = getCandidateRecord(guestCandidateId);
                const guestRunningMateId = firstRunningMateFor(guestCandidateId);
                const guestRunningMateRec = guestRunningMateId != null ? getCandidateRecord(guestRunningMateId) : null;

                e2.candidate_id = guestCandidateId;
                e2.running_mate_id = guestRunningMateId;
                e2.candidate_last_name = guestRec ? guestRec.fields.last_name : e2.candidate_last_name;
                e2.running_mate_last_name = guestRunningMateRec ? guestRunningMateRec.fields.last_name : e2.running_mate_last_name;
                if (guestRec && guestRec.fields.image_url) e2.candidate_image_url = guestRec.fields.image_url;
                if (guestRunningMateRec && guestRunningMateRec.fields.image_url) e2.running_mate_image_url = guestRunningMateRec.fields.image_url;
                e2.running_mate_state_id = runningMateStateIdFor(guestCandidateId);

                e2.opponents_list = computeOpponentsList(config.electionId, guestCandidateId);

                // Multiplayer bookkeeping
                e2.mp_opponent_candidate_id = config.hostCandidateId;
                e2.mp_running_mate_state_id_p2 = hostRunningMateStateId;
                e2.mp_guest_difficulty_multiplier = config.difficultyMultiplier;
                e2.player_answers_p2 = [];
                e2.player_visits_p2 = [];

                initMultiplayerState(config, "guest");

                // Render question 0 for the guest's candidate.
                const internals2 = getInternals();
                internals2.o(internals2.A(2));
            });
        }, 200);
    }

    // -----------------------------------------------------------------
    // 6. SHARED MULTIPLAYER STATE INIT
    // -----------------------------------------------------------------
    function initMultiplayerState(config, role) {
        const e = campaignTrail_temp;
        MP.active = true;
        MP.role = role;
        e.mp_active = true;

        if (role === "host") {
            e.mp_opponent_candidate_id = config.guestCandidateId;
            e.mp_running_mate_state_id_p2 = runningMateStateIdFor(config.guestCandidateId);
            e.mp_guest_difficulty_multiplier = config.difficultyMultiplier;
            if (!Array.isArray(e.player_answers_p2)) e.player_answers_p2 = [];
            if (!Array.isArray(e.player_visits_p2)) e.player_visits_p2 = [];
        }

        injectStatusBar();
        startTurnTimer(0);
        watchOpponentDisconnect();
    }

    // -----------------------------------------------------------------
    // 7. TURN SUBMISSION & SYNC
    // -----------------------------------------------------------------

    // Called from campaign_trail.js's n(t) instead of nextQuestion() when
    // multiplayer is active.
    MP.submitTurn = function (answerId) {
        const e = campaignTrail_temp;
        const qn = e.question_number;

        clearDeadlineTimer();
        $("#answer_select_button").prop("disabled", true);

        let visit = null;
        const hasVisits = e.election_json && e.election_json[getInternals().S(e.election_id)] &&
            e.election_json[getInternals().S(e.election_id)].fields.has_visits === 1;
        if (hasVisits && qn % 2 === 0 && e.player_visits && e.player_visits.length) {
            visit = e.player_visits[e.player_visits.length - 1];
        }

        const myRole = MP.role;
        $("#mp_status_bar").html(`<i>Waiting for your opponent's turn ${qn + 1}...</i>`);

        MP.roomRef.child(`turns/${qn}/${myRole}`).set({
            answer: Number(answerId),
            visit: visit,
            ts: Date.now(),
        }).then(() => {
            attachTurnListener(qn);
        });
    };

    function attachTurnListener(qn) {
        if (MP.turnListeners[qn]) return;
        const ref = MP.roomRef.child(`turns/${qn}`);
        MP.turnListeners[qn] = ref;
        ref.on("value", snap => {
            const data = snap.val();
            if (!data || !data.host || !data.guest) return;
            if (MP.appliedTurns[qn]) return;
            MP.appliedTurns[qn] = true;
            ref.off();
            applyTurn(qn, data);
        });
    }

    function applyTurn(qn, data) {
        const e = campaignTrail_temp;
        const internals = getInternals();

        const mine = MP.role === "host" ? data.host : data.guest;
        const theirs = MP.role === "host" ? data.guest : data.host;

        // Record the other player's answer/visit into the "_p2" history.
        e.player_answers_p2[qn] = theirs.answer;
        if (theirs.visit != null) {
            if (!Array.isArray(e.player_visits_p2)) e.player_visits_p2 = [];
            e.player_visits_p2.push(theirs.visit);
        }

        const questionCount = e.global_parameter_json[0].fields.question_count;
        const isFinalTurn = (qn + 1) === questionCount;

        if (isFinalTurn) {
            if (MP.role === "host") {
                internals.nextQuestion(); // will run A(1) + electionNight()
                MP.roomRef.child("final").set({
                    state_results: e.final_state_results,
                    overall_results: e.final_overall_results,
                });
            } else {
                e.question_number = qn + 1;
                $("#mp_status_bar").html(`<i>Tallying final results...</i>`);
                MP.roomRef.child("final").on("value", snap => {
                    const final = snap.val();
                    if (!final) return;
                    MP.roomRef.child("final").off();
                    e.final_state_results = final.state_results;
                    e.final_overall_results = final.overall_results;
                    internals.electionNight();
                    $("#mp_status_bar").remove();
                });
            }
            clearDeadlineTimer();
            return;
        }

        internals.nextQuestion();
        startTurnTimer(e.question_number);
        $("#mp_status_bar").html("");
    }

    // -----------------------------------------------------------------
    // 8. TURN TIMER
    // -----------------------------------------------------------------
    function startTurnTimer(questionNumber) {
        clearDeadlineTimer();

        const deadlineRef = MP.roomRef.child(`turns/${questionNumber}/deadline`);
        deadlineRef.transaction(current => {
            if (current) return current; // already set by the other player
            return Date.now() + MP.timeLimitSeconds * 1000;
        }).then(result => {
            const deadline = result.snapshot.val();
            MP.currentDeadline = deadline;
            runTimerUI(questionNumber, deadline);
        });
    }

    function runTimerUI(questionNumber, deadline) {
        $("#mp_turn_timer").remove();
        $("#game_window").append(`<div id="mp_turn_timer" style="position:fixed;top:10px;right:10px;
            background:#222;color:#fff;padding:0.5em 1em;border-radius:6px;font-weight:bold;z-index:9000;"></div>`);

        MP.deadlineTimer = setInterval(() => {
            const remaining = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
            const mins = Math.floor(remaining / 60);
            const secs = remaining % 60;
            $("#mp_turn_timer").text(`Turn time left: ${mins}:${secs.toString().padStart(2, "0")}`);

            if (remaining <= 0 && campaignTrail_temp.question_number === questionNumber) {
                clearInterval(MP.deadlineTimer);
                MP.deadlineTimer = null;
                autoSubmitTurn(questionNumber);
            }
        }, 1000);
    }

    // If the time limit expires before the local player answers, pick a
    // random valid answer (and visit, if applicable) on their behalf.
    function autoSubmitTurn(questionNumber) {
        const e = campaignTrail_temp;
        if (e.question_number !== questionNumber) return; // already moved on
        if ($("#visit_overlay")[0]) {
            // A visit confirmation popup is open — dismiss it without visiting.
            $("#no_visit_button").click();
        }
        if ($("#confirm_visit_button")[0]) {
            $("#confirm_visit_button").click();
        }

        // If we're on a visit-selection map and haven't picked a state yet,
        // best-effort: click a random state on the map to bring up the
        // confirmation popup, then confirm it.
        if (!$("#answer_select_button")[0] && $("#map_container")[0] && !$("#visit_overlay")[0]) {
            const paths = $("#map_container path, #map_container .state, #map_container [data-name]");
            if (paths.length) {
                paths.eq(Math.floor(Math.random() * paths.length)).trigger("click");
                setTimeout(() => {
                    if ($("#confirm_visit_button")[0]) $("#confirm_visit_button").click();
                    setTimeout(() => autoSubmitTurn(questionNumber), 300);
                }, 300);
                return;
            }
        }

        const radios = $("input[name=game_answers]");
        if (radios.length) {
            const idx = Math.floor(Math.random() * radios.length);
            radios.eq(idx).prop("checked", true);
            $("#answer_select_button").click();
        }
    }

    // -----------------------------------------------------------------
    // 9. STATUS BAR & DISCONNECT HANDLING
    // -----------------------------------------------------------------
    function injectStatusBar() {
        $("#mp_status_bar").remove();
        $("#game_window").append(`<div id="mp_status_bar" style="position:fixed;bottom:10px;right:10px;
            background:#222;color:#fff;padding:0.4em 1em;border-radius:6px;z-index:9000;max-width:300px;"></div>`);
    }

    function watchOpponentDisconnect() {
        // Mark presence; if this tab closes, let the other player know.
        const myRole = MP.role;
        const presenceRef = MP.roomRef.child(`presence/${myRole}`);
        presenceRef.onDisconnect().set({ left: true, ts: Date.now() });
        presenceRef.set({ left: false, ts: Date.now() });

        const otherRole = myRole === "host" ? "guest" : "host";
        MP.roomRef.child(`presence/${otherRole}`).on("value", snap => {
            const val = snap.val();
            if (val && val.left) {
                $("#mp_status_bar").html(`<b style="color:#ffb3b3;">Your opponent has disconnected.</b>`);
            }
        });
    }

    // -----------------------------------------------------------------
    // 10. INIT
    // -----------------------------------------------------------------
    $(function () {
        injectLobbyButton();
    });
})();
