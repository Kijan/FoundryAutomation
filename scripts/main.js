/**
 * Nisras Combat Automation
 * Foundry VTT v14 | dnd5e v5.3.3 | Midi-QOL v14 | DAE | Automated Conditions 5e
 *
 * Zentrales Designprinzip:
 *   Alle Entscheidungen/Dialoge laufen VOR der Chatkarte (preItemRoll / preAttackConfig),
 *   damit nichts nachträglich ergänzt werden muss.
 *
 *   Advantage-Verzicht bei Brutal Strike läuft über den v14 RollModifierTracker:
 *     workflow.tracker.advantage.suppress(...)  -> echter Normalwurf, quellenunabhängig,
 *     attributiert in der Chatkarte, kompatibel mit AC5E.
 *
 * Anpassen: die mit  // <-- ANPASSEN  markierten Stellen (Item-/Effekt-Namen, Actor-Identifikation).
 */

const MODULE_ID = "nisras-automation";

// Besser als Name-Vergleich: Actor-UUID in einer World-Setting speichern. Hier zur Lesbarkeit per Name.
const ACTOR_NAME = "Nisras";                                  // <-- ANPASSEN
const FEATURE_RAGE = "Rage";                                  // <-- ANPASSEN
const FEATURE_RECKLESS = "Reckless Attack";                   // <-- ANPASSEN
const FEATURE_FRENZY = "Frenzy";                              // <-- ANPASSEN
const EFFECT_RECKLESS_ON = "Attacking Recklessly";            // <-- ANPASSEN
const EFFECT_BS_DAMAGE = "Reckless Attack: Brutal Strike Damage"; // deaktivierter +1d10-Effekt am Item

// ---------------------------------------------------------------------------
// Per-Runden-Zustand, gekeyt auf die Combatant-ID (überlebt mehrere Angriffe/Aktivitäten der Runde)
// ---------------------------------------------------------------------------
const roundState = new Map(); // combatantId -> { firstAttackDone, frenzyDone }

function stateFor(workflow) {
  const key = workflow.token?.combatant?.id ?? workflow.actor.id;
  if (!roundState.has(key)) roundState.set(key, { firstAttackDone: false, frenzyDone: false });
  return roundState.get(key);
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------
const isNisras = (wf) => wf?.actor?.name === ACTOR_NAME;       // ggf. auf UUID umstellen
const isStrMelee = (wf) => wf?.activity?.actionType === "mwak"; // bei Bedarf zusätzlich Ability == "str" prüfen
const hasEffect = (actor, name) => actor.appliedEffects.some((e) => e.name === name && !e.disabled);

function hasRageCharges(actor) {
  // <-- ANPASSEN: je nach Item-Setup z.B. das Rage-Item / dessen uses prüfen
  const rage = actor.items.find((i) => i.name === FEATURE_RAGE);
  const uses = rage?.system?.uses;
  return uses ? (uses.value ?? 0) > 0 : true;
}

async function confirmDialog(title, content = "") {
  return foundry.applications.api.DialogV2.confirm({
    window: { title },
    content: content || `<p>${title}</p>`,
    rejectClose: false,
    modal: true,
  });
}

async function brutalStrikeDialog() {
  // Rückgabe: { use: boolean, effect: "forceful" | "hamstring" | "none" }
  const effect = await foundry.applications.api.DialogV2.wait({
    window: { title: "Brutal Strike nutzen?" },
    content: `<p>Brutal Strike: Advantage wird verworfen. Zusatzeffekt wählen:</p>`,
    buttons: [
      { action: "forceful", label: "Forceful Blow (15ft schieben)" },
      { action: "hamstring", label: "Hamstring Blow (Speed -15ft)" },
      { action: "none", label: "Kein Zusatzeffekt" },
      { action: "cancel", label: "Kein Brutal Strike" },
    ],
    rejectClose: false,
    modal: true,
  });
  return { use: effect && effect !== "cancel", effect: effect === "cancel" ? "none" : effect };
}

async function useFeature(actor, name) {
  const item = actor.items.find((i) => i.name === name);
  if (!item) return ui.notifications.warn(`${MODULE_ID}: Feature "${name}" nicht gefunden.`);
  // Eigener Workflow -> kein Re-Entry-Problem mit dem laufenden Angriffs-Workflow.
  return MidiQOL.completeItemUse(item, {}, { showFullCard: false });
}

// ===========================================================================
// 1) preItemRoll  — Rage- & Reckless-Dialoge (vor Targeting/Tracker)
// ===========================================================================
Hooks.on("midi-qol.preItemRoll", async (workflow) => {
  if (!isNisras(workflow) || !isStrMelee(workflow)) return true;
  const st = stateFor(workflow);
  const actor = workflow.actor;
  const firstAttack = !st.firstAttackDone;

  // --- RAGE ---
  if (firstAttack && !hasEffect(actor, FEATURE_RAGE) && hasRageCharges(actor)) {
    if (await confirmDialog("Rage aktivieren? (Bonus Action)")) {
      await useFeature(actor, FEATURE_RAGE);
    }
  }

  // --- RECKLESS ATTACK --- (setzt aktives Rage voraus)
  const ragingNow = hasEffect(actor, FEATURE_RAGE);
  if (firstAttack && ragingNow && !hasEffect(actor, EFFECT_RECKLESS_ON)) {
    if (await confirmDialog("Reckless Attack nutzen?")) {
      // Wendet "Attacking Recklessly" (Self, Advantage) + "Defending Recklessly" (Gegner) an
      await useFeature(actor, FEATURE_RECKLESS);
    }
  }

  return true; // false => Workflow abgebrochen
});

// ===========================================================================
// 2) preAttackConfig — Brutal-Strike-Entscheidung + ADVANTAGE-VERZICHT (Kern!)
//    Tracker existiert hier; letzte Modifikationsstelle vor dem Wurf.
// ===========================================================================
Hooks.on("midi-qol.preAttackConfig", async (workflow) => {
  if (!isNisras(workflow) || !isStrMelee(workflow)) return;

  const recklessActive = hasEffect(workflow.actor, EFFECT_RECKLESS_ON);
  const tracker = workflow.tracker; // == workflow.attackRollModifierTracker

  // Reckless-Advantage für DIESEN Wurf sicher in den Tracker (falls der AE zu spät greift)
  if (recklessActive && !tracker.hasAdvantage) {
    tracker.advantage.add("Reckless Attack", "Attacking Recklessly");
  }

  // Brutal Strike nur bei jedem Angriff, wenn reckless aktiv UND kein Disadvantage vorliegt
  if (recklessActive && !tracker.hasDisadvantage) {
    const choice = await brutalStrikeDialog();
    if (choice.use) {
      workflow.brutalStrike = choice; // für Damage- und Treffer-Stufen merken

      // *** ZENTRALE LÖSUNG ***
      // Echter Normalwurf, quellenunabhängig, attributiert, AC5E-kompatibel:
      tracker.advantage.suppress("Brutal Strike", "Brutal Strike – Advantage verzichtet");
      // Minimal-Alternative (backwards compatible): workflow.noAdvantage = true;
    }
  }
});

// ===========================================================================
// 3) preDamageRoll — +1d10 Brutal-Strike-Schaden, mit Once-Guard gegen Mehrfachfeuer
// ===========================================================================
Hooks.on("midi-qol.preDamageRoll", (workflow) => {
  if (!isNisras(workflow) || !workflow.brutalStrike) return;
  if (workflow._bsDamageApplied) return;        // Guard: verhindert doppeltes Hinzufügen
  workflow._bsDamageApplied = true;

  // Schaden direkt ergänzen statt den deaktivierten Item-Effekt zu togglen (vermeidet Race/Mehrfachfeuer).
  // Variante A: über damageBonus/DamageRoll-Parts (je nach deiner Item-Struktur).
  // Variante B: Effekt EFFECT_BS_DAMAGE genau hier aktivieren und in postDamageRoll wieder deaktivieren.
  // TODO: an dein Schadens-Setup anpassen, z.B.:
  // workflow.damageRolls?.push(await new CONFIG.Dice.DamageRoll("1d10", {}, {type: "slashing"}).evaluate());
});

// ===========================================================================
// 4) hitsChecked — Frenzy (erster Treffer der Runde) + Brutal-Strike-Zusatzeffekte
// ===========================================================================
Hooks.on("midi-qol.hitsChecked", async (workflow) => {
  if (!isNisras(workflow)) return;
  const st = stateFor(workflow);
  const hit = workflow.hitTargets?.size > 0;

  // --- FRENZY: erster Treffer der Runde, wenn reckless aktiv ---
  if (hit && !st.frenzyDone && hasEffect(workflow.actor, EFFECT_RECKLESS_ON)) {
    st.frenzyDone = true;
    // Re-Entry vermeiden: nach dem aktuellen Workflow feuern.
    Hooks.once("midi-qol.RollComplete", () => useFeature(workflow.actor, FEATURE_FRENZY));
  }

  // --- BRUTAL STRIKE Zusatzeffekte bei Treffer ---
  if (hit && workflow.brutalStrike) {
    const target = workflow.hitTargets.first();
    if (workflow.brutalStrike.effect === "hamstring") {
      // DAE-Effekt aufs Ziel: Speed -15ft bis zum Start von Nisras' nächstem Zug.
      // Dauer: flags.dae.specialDuration = ["turnStartSource"]  (Times-Up regelt Ablauf)
      // TODO: ActiveEffect mit change system.attributes.movement.walk | ADD | -15 anlegen/anwenden.
    } else if (workflow.brutalStrike.effect === "forceful") {
      // Spieler dürfen fremde Tokens nicht bewegen -> GM-bestätigter Chat-Button.
      await postForcefulBlowButton(workflow, target);
    }
  }
});

// ---------------------------------------------------------------------------
// Forceful Blow: Chat-Button, den ein GM ausführt (Token-Bewegung braucht GM-Rechte).
// Sauberer Weg: socketlib -> GM-seitige Funktion registrieren und vom Button aufrufen.
// ---------------------------------------------------------------------------
async function postForcefulBlowButton(workflow, target) {
  if (!target) return;
  const content = `
    <p><b>Forceful Blow:</b> ${target.name} 15ft wegschieben?</p>
    <button class="nisras-forceful" data-target="${target.id}" data-source="${workflow.token?.id}">
      15ft schieben (GM bestätigt)
    </button>`;
  await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor: workflow.actor }) });
  // TODO: Listener in renderChatMessageHTML registrieren; Bewegung GM-seitig via socketlib ausführen.
}

// ===========================================================================
// 5) Rundenreset
// ===========================================================================
Hooks.on("combatTurnChange", (combat, prior, current) => {
  // Beim Beginn von Nisras' Zug den Per-Runden-Zustand zurücksetzen.
  const combatant = combat.combatants.get(current?.combatantId);
  if (combatant?.actor?.name === ACTOR_NAME) {
    roundState.set(combatant.id, { firstAttackDone: false, frenzyDone: false });
  }
});

// firstAttackDone markieren, sobald der erste Angriff der Runde durch ist
Hooks.on("midi-qol.RollComplete", (workflow) => {
  if (!isNisras(workflow) || !isStrMelee(workflow)) return;
  stateFor(workflow).firstAttackDone = true;
});

console.log(`${MODULE_ID} | geladen`);